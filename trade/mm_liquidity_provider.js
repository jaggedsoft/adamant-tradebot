const $u = require('../helpers/utils');
const config = require('../modules/configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const tradeParams = require('./tradeParams_' + config.exchange);
const traderapi = require('./trader_' + config.exchange)(config.apikey, config.apisecret, config.apipassword, log);
const db = require('../modules/DB');

let lastNotifyBalancesTimestamp = 0;
let lastNotifyPriceTimestamp = 0;
const HOUR = 1000 * 60 * 60;
// const INTERVAL_MIN = 60000;
// const INTERVAL_MAX = 100000;
const INTERVAL_MIN = 6000;
const INTERVAL_MAX = 10000;
const LIFETIME_MIN = HOUR;
const LIFETIME_MAX = HOUR * 10;
const MAX_ORDERS = 6; // each side

module.exports = {
	run() {
        this.iteration();
    },
    iteration() {
        let interval = setPause();
        console.log(interval);
        if (interval && tradeParams.mm_isActive && tradeParams.mm_isLiquidityActive) {
            this.updateLiquidity();
            setTimeout(() => {this.iteration()}, interval);
        } else {
            setTimeout(() => {this.iteration()}, 3000); // Check for config.mm_isActive every 3 seconds
        }
    },
	async updateLiquidity() {

        try {

            const {ordersDb} = db;
            let liquidityOrders = await ordersDb.find({
                isProcessed: false,
                purpose: 'liq', // liq: liquidity order
                pair: config.pair,
                exchange: config.exchange
            });

            console.log('liquidityOrders-0', liquidityOrders.length);
            liquidityOrders = await this.closeLiquidityOrders(liquidityOrders); // close expired orders
            console.log('liquidityOrders-1', liquidityOrders.length);
            liquidityOrders = await this.updateLiquidityOrders(liquidityOrders); // update orders which partially filled
            console.log('liquidityOrders-2', liquidityOrders.length);

            let liquidityStats = $u.getOrdersStats(liquidityOrders);
            console.log(liquidityStats);

            let amountPlaced;
            do {
                amountPlaced = await this.placeLiquidityOrder(liquidityStats.bidsTotalQuoteAmount, 'buy');            
                liquidityStats.bidsTotalQuoteAmount += amountPlaced;
            } while (amountPlaced);
            do {
                amountPlaced = await this.placeLiquidityOrder(liquidityStats.asksTotalAmount, 'sell');            
                liquidityStats.asksTotalAmount += amountPlaced;
            } while (amountPlaced);
    
            log.info(`Liquidity stats: opened ${liquidityStats.bidsCount} bids-buy orders for ${liquidityStats.bidsTotalQuoteAmount.toFixed(config.coin2Decimals)} of ${tradeParams.mm_liquidityBuyAmount} ${config.coin2} and ${liquidityStats.asksCount} asks-sell orders with ${liquidityStats.asksTotalAmount.toFixed(config.coin1Decimals)} of ${tradeParams.mm_liquiditySellAmount} ${config.coin1}.`);

        } catch (e) {
            log.error('Error in updateLiquidity(): ' + e);
        }
    },
	async closeLiquidityOrders(liquidityOrders) {

        let updatedLiquidityOrders = [];
        for (const order of liquidityOrders) {
            try {
                if (order.dateTill < $u.unix()) {
                    await traderapi.cancelOrder(order._id, order.type, order.pair);
                    await order.update({
                        isProcessed: true,
                        isClosed: true
                    }, true);
                    log.info(`Closing liq-order with params: id=${order._id}, type=${order.targetType}, pair=${order.pair}, price=${order.price}, coin1Amount=${order.coin1Amount}, coin2Amount=${order.coin2Amount}.`);
                } else {
                    updatedLiquidityOrders.push(order);
                }
            } catch (e) {
                log.error('Error in closeLiquidityOrders(): ' + e);
            }
        }
        return updatedLiquidityOrders;

    },
    async updateLiquidityOrders(liquidityOrders) {

        let updatedLiquidityOrders = [];
        try {

            const exchangeOrders = await traderapi.getOpenOrders(config.pair);
            if (exchangeOrders) {
                console.log('exchangeOrders:', exchangeOrders.length);
                for (const dbOrder of liquidityOrders) {
                    for (const exchangeOrder of exchangeOrders) {

                        // console.log(dbOrder._id, exchangeOrder.orderid, exchangeOrder.status);
                        if (dbOrder._id === exchangeOrder.orderid) {
                            // console.log('match:', dbOrder._id, exchangeOrder.orderid, exchangeOrder.status);
                            switch (exchangeOrder.status) {
                                case "new":
                                    updatedLiquidityOrders.push(dbOrder);
                                    break;
                                case "closed":
                                    await dbOrder.update({
                                        isProcessed: true,
                                        isClosed: true
                                    }, true);
                                    log.info(`Updating liq-order with params: id=${dbOrder._id}, type=${dbOrder.targetType}, pair=${dbOrder.pair}, price=${dbOrder.price}, coin1Amount=${dbOrder.coin1Amount}, coin2Amount=${dbOrder.coin2Amount}: order is closed.`);
                                    break;
                                case "filled":
                                    await dbOrder.update({
                                        isProcessed: true,
                                        isFilled: true
                                    }, true);
                                    log.info(`Updating liq-order with params: id=${dbOrder._id}, type=${dbOrder.targetType}, pair=${dbOrder.pair}, price=${dbOrder.price}, coin1Amount=${dbOrder.coin1Amount}, coin2Amount=${dbOrder.coin2Amount}: order is filled.`);
                                    break;
                                case "part_filled":
                                    if (dbOrder.coin1Amount > exchangeOrder.amountLeft) {
                                        let prev_amount = dbOrder.coin1Amount;
                                        await dbOrder.update({
                                            isFilled: true,
                                            coin1Amount: exchangeOrder.amountLeft
                                        }, true);
                                        updatedLiquidityOrders.push(dbOrder);
                                        log.info(`Updating liq-order with params: id=${dbOrder._id}, type=${dbOrder.targetType}, pair=${dbOrder.pair}, price=${dbOrder.price}, coin1Amount=${prev_amount}, coin2Amount=${dbOrder.coin2Amount}: order is partly filled—amount left: ${dbOrder.coin1Amount}.`);
                                    }
                                    break;										
                                default:
                                    updatedLiquidityOrders.push(dbOrder);
                                    break;
                            } // switch
                        } // if match orderId
                        
                    }
                }
            } // if exchangeOrders

        } catch (e) {
            log.error('Error in updateLiquidityOrders(): ' + e);
        }
        
        return updatedLiquidityOrders;

    },
	async placeLiquidityOrder(amountPlaced, orderType) {

        const type = orderType;

        const priceReq = await setPrice(type);
        const price = priceReq.price;
        if (!price) {
            if ((Date.now()-lastNotifyPriceTimestamp > HOUR) && priceReq.message) {
                notify(priceReq.message, 'warn');
                lastNotifyPriceTimestamp = Date.now();
            }
            return;
        }

        const coin1Amount = setAmount(type, price);
        const coin2Amount = coin1Amount * price;
        const lifeTime = setLifeTime();

        let orderId;
        let output = '';
        let orderParamsString = '';
        const pairObj = $u.getPairObj(config.pair);

        orderParamsString = `type=${type}, pair=${config.pair}, price=${price}, coin1Amount=${coin1Amount}, coin2Amount=${coin2Amount}`;
        if (!type || !price || !coin1Amount || !coin2Amount) {
            notify(`${config.notifyName} unable to run liq-order with params: ${orderParamsString}.`, 'warn');
            return;
        }

        // console.log(type, price.toFixed(8), coin1Amount.toFixed(2), coin2Amount.toFixed(2), 'lifeTime:', lifeTime);
        // console.log('amountPlaced:', amountPlaced);

        if (type === 'sell') {
            if (coin1Amount > (tradeParams.mm_liquiditySellAmount - amountPlaced)) {
                console.log(`Exceeded liquidity amounts to ${type}. Pending: ${coin1Amount.toFixed(config.coin1Decimals)}, placed: ${amountPlaced.toFixed(config.coin1Decimals)}, limit: ${tradeParams.mm_liquiditySellAmount} ${config.coin1}.`);
                return false;    
            } 
        }

        if (type === 'buy') {
            if (coin2Amount > (tradeParams.mm_liquidityBuyAmount - amountPlaced)) {
                console.log(`Exceeded liquidity amounts to ${type}. Pending: ${coin2Amount.toFixed(config.coin2Decimals)}, placed: ${amountPlaced.toFixed(config.coin2Decimals)}, limit: ${tradeParams.mm_liquidityBuyAmount} ${config.coin2}.`);
                return false;    
            } 
        }

        // Check balances
        const balances = await isEnoughCoins(config.coin1, config.coin2, coin1Amount, coin2Amount, type);
        if (!balances.result) {
            if ((Date.now()-lastNotifyBalancesTimestamp > HOUR) && balances.message) {
                notify(balances.message, 'warn', config.silent_mode);
                lastNotifyBalancesTimestamp = Date.now();
            }
            return;
        }

        orderId = (await traderapi.placeOrder(type, config.pair, price, coin1Amount, 1, null, pairObj)).orderid;
        if (orderId) {
            const {ordersDb} = db;
            const order = new ordersDb({
                _id: orderId,
                date: $u.unix(),
                dateTill: $u.unix() + lifeTime,
                purpose: 'liq', // liq: liquidity & spread
                type: type,
                targetType: type,
                exchange: config.exchange,
                pair: config.pair,
                coin1: config.coin1,
                coin2: config.coin2,
                price: price,
                coin1Amount: coin1Amount,
                coin2Amount: coin2Amount,
                LimitOrMarket: 1,  // 1 for limit price. 0 for Market price.
                isProcessed: false,
                isExecuted: false,
                isCancelled: false,
                isClosed: false
            }, true);
            output = `${type} ${coin1Amount.toFixed(config.coin1Decimals)} ${config.coin1} for ${coin2Amount.toFixed(config.coin2Decimals)} ${config.coin2}`;
            log.info(`Successfully placed liq-order to ${output}.`);
            if (type === 'sell')
                return coin1Amount
            else
                return coin2Amount;

        } else {
            console.warn(`${config.notifyName} unable to execute liq-order with params: ${orderParamsString}. No order id returned.`);
            return false;
        }

    },
    
};

async function isEnoughCoins(coin1, coin2, amount1, amount2, type) {
	const balances = await traderapi.getBalances(false);
    let balance1, balance2;
    let balance1freezed, balance2freezed;
    let isBalanceEnough = true;
    let output = '';

    if (balances) {
		try {
            balance1 = balances.filter(crypto => crypto.code === coin1)[0].free;
            balance2 = balances.filter(crypto => crypto.code === coin2)[0].free;
            balance1freezed = balances.filter(crypto => crypto.code === coin1)[0].freezed;
            balance2freezed = balances.filter(crypto => crypto.code === coin2)[0].freezed;

            if ((!balance1 || balance1 < amount1) && type === 'sell') {
                output = `${config.notifyName}: Not enough balance to place ${amount1.toFixed(config.coin1Decimals)} ${coin1} ${type} liq-order. Free: ${balance1.toFixed(config.coin1Decimals)} ${coin1}, freezed: ${balance1.toFixed(config.coin1Decimals)} ${coin1}.`;
                isBalanceEnough = false;
            }
            if ((!balance2 || balance2 < amount2) && type === 'buy') {
                output = `${config.notifyName}: Not enough balance to place ${amount2.toFixed(config.coin2Decimals)} ${coin2} ${type} liq-order. Free: ${balance2.toFixed(config.coin2Decimals)} ${coin2}, freezed: ${balance2.toFixed(config.coin2Decimals)} ${coin2}.`;
                isBalanceEnough = false;
            }

            // console.log(balance1.toFixed(0), amount1.toFixed(0), balance2.toFixed(8), amount2.toFixed(8));
            return {
                result: isBalanceEnough,
                message: output
            }

		} catch (e) {
            log.warn(`Unable to process balances for placing liq-order.`);
            return {
                result: false
            }
        }
	} else {
        log.warn(`Unable to get balances for placing liq-order.`);
        return {
            result: false
        }
    }
}

async function setPrice(type) {

    let output = '';

    let high, low;
    let orderBookInfo = $u.getOrderBookInfo(await traderapi.getOrderBook(config.pair));

    if (!orderBookInfo) {
        output = `${config.notifyName}: Order books are empty for ${config.pair}, or temporary API error. Unable to get spread for ${pair} while placing liq-order.`;
        return {
            price: false,
            message: output
        }
    }

    switch (tradeParams.mm_liquidityTrend) {
        case "downtrend":
            targetPrice = orderBookInfo.downtrendAveragePrice;
            break;
        case "uptrend":
            targetPrice = orderBookInfo.uptrendAveragePrice;
            break;
        case "middle":
            targetPrice = orderBookInfo.middleAveragePrice;
            break;
        default:
            break;
    }

    if (type === 'sell') {
        low = targetPrice;
        high = targetPrice * (1 + tradeParams.mm_liquiditySpreadPercent/100 / 2);
    } else {
        high = targetPrice;
        low = targetPrice * (1 - tradeParams.mm_liquiditySpreadPercent/100 / 2);
    }

    return {
        price: $u.randomValue(low, high)
    }

}

function setAmount(type, price) {

    if (!tradeParams || !tradeParams.mm_liquiditySellAmount || !tradeParams.mm_liquidityBuyAmount) {
        log.warn(`Params mm_liquiditySellAmount or mm_liquidityBuyAmount are not set. Check ${config.exchangeName} config.`);
        return false;
    }

    let min, max;

    if (type === 'sell') {
        min = tradeParams.mm_liquiditySellAmount / MAX_ORDERS;
        max = tradeParams.mm_liquiditySellAmount / 3 * 2;
    } else {
        min = tradeParams.mm_liquidityBuyAmount / price / MAX_ORDERS;
        max = tradeParams.mm_liquidityBuyAmount / price / 3 * 2;
    }

    return $u.randomValue(min, max);
}

function setLifeTime() {
    return $u.randomValue(LIFETIME_MIN, LIFETIME_MAX, true);
}

function setPause() {
    return $u.randomValue(INTERVAL_MIN, INTERVAL_MAX, true);
}