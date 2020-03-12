ADAMANT Trading & Market making bot is a software that allows to run trades on crypto exchanges or make fake volume. Trading is a mode when bot run orders according to some strategy. It can be profitable or not.
In Market making mode, the bot places orders and execute them by himself, making a trade volume.
Trade bots work in ADAMANT Messenger chats directly.

Features:

* Managed with your commands using ADAMANT Messenger
* Easy to install and configure
* Free and open source
* Fill order books
* Market making
* Stores and displays statistics

Supported exchanges (more in progress):

* [IDCM](https://idcm.io/invitation/receive?code=LM5510&lang=en)

Available commands: ask a bot with `/help` command. Read more: [M]().

# Installation

## Requirements

* Ubuntu 16 / Ubuntu 18 (other OS had not been tested)
* NodeJS v 8+
* MongoDB ([installation instructions](https://docs.mongodb.com/manual/tutorial/install-mongodb-on-ubuntu/))

## Setup

```
su - adamant
git clone https://github.com/Adamant-im/adamant-tradebot
cd ./adamant-tradebot
npm i
```

## Pre-launch tuning

```
nano config.json
```

Parameters:

* `exchange` <string> Exchange to work with. Available values see above. Case insensitive, obligatory.
* `pair` <string> Pair to with on the exchange. Obligatory.
* `apikey` <string> Exchange's account API key for connection. Obligatory.
* `apisecret` <string> Exchange's account API secret for connection. Obligatory.
* `apipassword` <string> Exchange's account trade password. If needed for exchange.
* `passPhrase` <string> The bot's secret phrase for accepting commands. Obligatory. Bot's ADM address will correspond this passPhrase.
* `admin_accounts` <string, array> ADAMANT accounts to accept commands from. Commands from other accounts will not be executed. At lease one account.
* `notify_non_admins` <boolean> Notify non-admins that they are not admins. If false, bot will be silent.
* `node_ADM` <string, array> List of nodes for API work, obligatorily
* `infoservice` <string, array> List of [ADAMANT InfoServices](https://github.com/Adamant-im/adamant-currencyinfo-services) for catching exchange rates, recommended
* `slack` <string> Token for Slack alerts for the bot’s administrator. No alerts if not set.
* `adamant_notify` <string> ADM address for the bot’s administrator. Recommended.
* `socket` <boolean> If to use WebSocket connection. Recommended for better user experience.
* `ws_type` <string> Choose socket connection, "ws" or "wss" depending on your server.
* `bot_name` <string> Bot's name for notifications.
* `welcome_string` <string> How to reply user in-chat, if unknown command received.

## Launching

You can start the Bot with the `node app` command, but it is recommended to use the process manager for this purpose.

```
pm2 start --name tradebot app.js
```

## Add Bot to cron

```
crontab -e
```

Add string:

```
@reboot cd /home/adamant/adamant-tradebot && pm2 start --name tradebot app.js
```

## Updating

```
su - adamant
cd ./adamant-tradebot
pm2 stop tradebot
mv config.json config_bup.json && git pull && mv config_bup.json config.json
npm i
pm2 start --name tradebot app.js
```