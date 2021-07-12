export {};

const yargs = require('yargs');
let config = require('./config.json');

const argv = yargs
  .option('profile', {
    alias: 'p',
    description: 'The config profile.',
    type: 'string'
  })
  .option('list', {
    alias: 'l',
    description: 'List available config profiles.'
  })
  .help()
  .alias('help', 'h')
  .argv;

if(argv.list) {
  if(Object.keys(config).length == 1) {
    console.log('You havent created any config profiles.');
  } else {
    console.log('Config profiles:');
    Object.keys(config).forEach(name => {
      if(name == 'default') return;
      console.log('- '+name);
    });
  }
  process.exit(0);
}

if(argv.profile && config[argv.profile] == null) {
  console.log(`Profile ${argv.profile} does not exist.`);
  process.exit(1);
}

const fs = require('fs');

// the boundingBox of nether portals and carpets have to be changed to empty
const minecraft_data_blocks = require('./node_modules/minecraft-data/minecraft-data/data/pc/1.8/blocks.json');
let changed = false;
for(let i=0; i<minecraft_data_blocks.length; i++) {
  if(minecraft_data_blocks[i].id == 90 || minecraft_data_blocks[i].id == 171) {
    if(minecraft_data_blocks[i].boundingBox != 'empty') {
      minecraft_data_blocks[i].boundingBox = 'empty';
      changed = true;
    }
  }
}
if(changed) fs.writeFileSync('./node_modules/minecraft-data/minecraft-data/data/pc/1.8/blocks.json', JSON.stringify(minecraft_data_blocks, null, 4));

const gg = require('griefergames-bot');
const dateFormat = require('dateformat');
const prompt = require('serverline');

const cityBuildConnectLimit = 3;
const serverKickLimit = 5;

let credentials;
let bot;
let onlineTimeInterval;
let connectingToCityBuild = false;
let currentCityBuild = 'Offline';
let serverKickCounter = 0;
let onlineTime = 0;
let income = 0;
let broadcastMessage = false;

let profile = argv.profile != null ? argv.profile : 'default';
loadConfig();
loadCredentials();

let logFile;
if(config.logMessages) {
  if(!fs.existsSync('logs/')) {
    fs.mkdirSync('logs/');
  }

  let logFileName = `logs/${dateFormat('dd-mm-yyyy')}-${config.account}.log`;
  let counter = 0;
  while(fs.existsSync(logFileName)) {
    counter++;
    logFileName = `logs/${dateFormat('dd-mm-yyyy')}-${config.account}-${counter}.log`;
  }
  logFile = fs.openSync(logFileName, 'a');
}

async function startBot() {
  log('Connecting to server...');

  const botOptions: any = {
    cacheSessions: true,
    logMessages: false,
    solveAfkChallenge: true,
    setPortalTimeout: false,
    auth: credentials.authType,
    username: credentials.email,
    password: credentials.password
  };

  bot = gg.createBot(botOptions);
  
  try {
    await bot.init();
  } catch(err) {
    if(err.message.startsWith('Invalid credentials.')) {
      log('Error while logging in: '+err.message);
      exit();
      return;
    } else {
      throw err;
    }
  }
  
  bot.on('ready', async () => {
    prompt.setPrompt(bot.client.username+'> ');
    log('Connected as '+bot.client.username+'. Trying to connect to CityBuild...');

    // count time bot is on the server in minutes
    onlineTimeInterval = setInterval(() => onlineTime++, 60000);
    
    // connect to citybuild
    if(config.citybuild != '') {
      connectingToCityBuild = true;
      let connectErrorCount = 0;
      while(connectErrorCount < cityBuildConnectLimit && connectingToCityBuild) {
        const result: any = await connectToCitybuild(config.citybuild);
        if(result.success) {
          connectingToCityBuild = false;
          log(`Connected to CityBuild ${currentCityBuild.replace('CB', '')}.`);
          // wait 2s until fully connected
          setTimeout(() => {
            // execute commands
            config.commands.forEach(cmd => {
              bot.sendCommand(cmd);
            });
          }, 2000);
        } else {
          connectErrorCount++;
          log('Couldn\'t connect to CityBuild: '+result.error);
        }
      }
      if(connectErrorCount >= cityBuildConnectLimit) {
        log('---------------------------------------------');
        log('CityBuild connect limit exceeded!');
        exit();
      }
    }
  });
  
  // handle kick event
  const ChatMessage = require('prismarine-chat')(bot.client.version);
  bot.on('kicked', reason => {
    reason = new ChatMessage(JSON.parse(reason));
    log('Got kicked from the server: '+reason.toAnsi());

    if(credentials.authType == 'mcleaks') {
      exit();
      return;
    }

    switch(reason.toString()) {
      case "Der Server wird heruntergefahren.":
        stopBot();
        if(!config.reconnectAfterRestart) {
          exit();
          break;
        }
        setTimeout(() => {
          startBot();
        }, 3600000); // 60min
        break;
      case "Du bist schon zu oft online!":
        exit();
        break;
      default:
        handleKick(5000);
    }
  });

  bot.on('end', () => {
    log('Got kicked from the server: Connection lost.');

    if(credentials.authType == 'mcleaks') {
      exit();
      return;
    }

    handleKick(5000);
  });
  
  // handle msg event
  bot.on('msg', (rank, username, message) => {
    if(config.authorisedPlayers.includes(username)) {
      // Authorised players
      const cmd = message.split(' ');
      switch(cmd[0]) {
        case 'logout':
          config.authorisedPlayers = config.authorisedPlayers.filter(e => e !== username);
          bot.sendMsg(username, 'Du bist nun abgemeldet.');
          break;
        case 'chat':
          if(cmd.length >= 2) {
            cmd.shift()
            bot.sendChat(cmd.join(' '));
          } else {
            bot.sendMsg(username, 'Verwendung: chat <Nachricht|Befehl>');
          }
          break;
        case 'stop':
          bot.sendMsg(username, 'Bot wird beendet.');
          exit();
          break;

        case 'dropinv':
          dropInventory();
          break;
          
        default:
          bot.sendMsg(username, `Der Befehl "${message}" wurde nicht gefunden.`);
      }
    } else {
      // Not authorised players
      if(message.startsWith('login')) {
        const cmd = message.split(' ');
        if(cmd.length == 2 && cmd[1] === credentials.controlPassword) {
          config.push(username);
          bot.sendMsg(username, 'Hey, du bist nun angemeldet.');
        } else {
          bot.sendMsg(username, 'Das Passwort ist nicht korrekt!')
        }
      } else if(config.msgResponseActive) {
        bot.sendMsg(username, config.msgResponse);
      }
    }
  });
  
  // handle chat message event
  bot.on('message', (message, position) => {
    // removes other than chat messages
    if(position == 2) return;

    handleChatMessage(message);

    const delayRegex = message.toString().match(/^Der Server konnte deine Daten noch nicht verarbeiten\. Du wurdest für (\d{1,2}) Minuten gesperrt!$/);
    if(delayRegex != null) {
      const delay = parseInt(delayRegex[1]) + 2;
      log('Got blocked from CityBuild, reconnecting in '+delay+' minutes.');
      handleKick(delay * 60000);
    }
  });

  bot.on('tpa', (rank, name) => {
    if(config.authorisedPlayers.includes(name)) {
      bot.sendCommand('tpaccept '+name);
    }
  });

  bot.on('tpahere', (rank, name) => {
    if(config.authorisedPlayers.includes(name)) {
      bot.sendCommand('tpaccept '+name);
    }
  });

  bot.on('pay', (rank, username, amount, text, codedText) => {
    income += amount;
  });

  bot.on('moneydrop', amount => {
    income += amount;
  });

  bot.on('scoreboardServer', server => {
    currentCityBuild = server;
  });
  
  bot.client._client.on('packet', (data, metadata) => {
    if(metadata.name == 'custom_payload' && data.channel == 'mysterymod:mm') {
      const dataBuffer = data.data;

      let i = 0;
      let j = 0;
      let b0;

      do {
          b0 = dataBuffer.readInt8();
          i |= (b0 & 127) << j++ * 7;
          if (j > 5) {
              return;
          }
      } while((b0 & 128) == 128);

      const key = dataBuffer.slice(0, i+1).toString();
      const message = dataBuffer.slice(i+1).toString();

      if(key.includes('mysterymod_user_check')) {
        bot.client._client.write('custom_payload', {
          channel: 'mysterymod:mm',
          data: Buffer.from(message)
        });
      }
    }
  });

  bot.on('error', err => {
    if(err.message.startsWith('MCLeaks')) {
      log('Error while reedeming token: '+err.message);
      exit();
    } else {
      throw err;
    }
  });
}

function handleKick(reconnectDelay: number) {
  stopBot();
  serverKickCounter++;
  if(serverKickCounter < serverKickLimit) {
    setTimeout(() => {
      startBot();
    }, reconnectDelay);
  } else {
    log('---------------------------------------------');
    log('Server connect limit exceeded!');
    exit();
  }
}

function handleChatMessage(message: any) {
  // remove empty lines
  if(message.toString().trim() == '') return;

  // remove supreme newlines
  if(message.toString().trim() == '»') return;

  // remove broadcast messages
  if(message.toString() == '------------ [ News ] ------------') {
    broadcastMessage = !broadcastMessage;
    return;
  }
  if(broadcastMessage) return;

  log('[Chat] '+message.toAnsi(), config.displayChat);
}

function connectToCitybuild(citybuild: string) {
  return new Promise(async resolve => {
    const timeout = setTimeout(() => {
      resolve({success: false, error: 'Timed out while connecting to CityBuild.'});
    }, 60000);
    try {
      await bot.connectCityBuild(citybuild);
      clearTimeout(timeout);
      resolve({success: true});
    } catch(err) {
      clearTimeout(timeout);
      resolve({success: false, error: err.message});
    }
  });
}

function stopBot() {
  if(bot != null) {
    bot.removeAllListeners();
    bot.clean();
    bot = null;
  }
  connectingToCityBuild = false;
  broadcastMessage = false;
  currentCityBuild = 'Offline';
  clearInterval(onlineTimeInterval);
}

function exit() {
  log(`Stopping bot... (Online time: ${Math.round(onlineTime / 60)}h ${onlineTime % 60}min${credentials.authType == 'mcleaks' ? ' | Token: '+credentials.password : ''})`);
  if(bot != null) bot.clean();
  setTimeout(() => process.exit(), 100);
}

function dropInventory(): Promise<void> {
  return new Promise(async resolve => {
    await asyncForEach(bot.client.inventory.items(), async item => {
        await new Promise(resolve1 => {
            bot.client.tossStack(item, resolve1);
        });
    });
    resolve();
  });
}

function loadConfig() {
  try {
    const configFile = JSON.parse(fs.readFileSync('./config.json'));
    config = Object.assign(configFile.default, configFile[profile]);
    config.msgResponseActive = config.msgResponse != '';
  } catch(err) {
    log('Couldn\'t load config: '+err.message);
  }
}
function loadCredentials() {
  const credentialsFile = JSON.parse(fs.readFileSync('./credentials.json'));
  credentials = credentialsFile.minecraftAccounts[config.account];
}


if(credentials.authType == 'mcleaks') {
  log('Please create an token on https://mcleaks.net/get and enter it here.');
} else {
  startBot();
}

// command prompt
prompt.init();
prompt.setCompletion(['#help', '#stop', '#msgresponse', '#togglechat', '#onlinetime', '#listplayers', '#citybuild', '#authorise', '#unauthorise',
  '#listauthorised', '#dropinv', '#listinv', '#reloadconfig', '#income']);
prompt.on('SIGINT', () => {
  exit();
});
prompt.on('line', async msg => {
  if(credentials.authType == 'mcleaks' && !credentials.password) {
    credentials.password = msg;
    startBot();
    return;
  }
  if(msg.trim().startsWith('#')) {
    // bot commands
    const args = msg.trim().substr(1).split(' ');
    switch(args[0].toLowerCase()) {
      case 'help':
        log('Available commands:');
        log('#help - Print this list.');
        log('#stop - Stop the bot.');
        log('#msgresponse [on|off] - Enable or disable automatic response to private messages.');
        log('#togglechat - Show or hide the chat.');
        log('#onlinetime - Show the online time of the bot.');
        log('#listplayers - List the currently online players.');
        log('#citybuild [cb name] [join command] - Change CityBuild.');
        log('#authorise <name> - Authorise a player to execute bot commands.');
        log('#unauthorise <name> - Unauthorise a player.');
        log('#listauthorised - List the authorised players.');
        log('#dropinv - Let the bot drop all items in its inventory.');
        log('#listinv - Display the bots inventory.');
        log('#reloadconfig - Reload the configuration file.');
        log('#income - Show income since login.');
        break;

      case 'stop':
        exit();
        break;
      
      case 'msgresponse':
        if(args.length == 1) {
          log('Automatic response is '+(config.msgResponseActive ? 'on.' : 'off.'));
        } else {
          if(args[1].toLowerCase() == 'on') {
            if(config.msgResponse != '') {
              config.msgResponseActive = true;
              log('Turned on automatic response.');
            } else {
              log('No response specified in config file.');
            }
          } else if(args[1].toLowerCase() == 'off') {
            config.msgResponseActive = false;
            log('Turned off automatic response.');
          } else {
            log('Usage: #msgresponse [on|off]');
          }
        }
        break;

      case 'togglechat':
        config.displayChat = !config.displayChat;
        log((config.displayChat ? 'Enabled' : 'Disabled')+' chat messages.');
        break;

      case 'onlinetime':
        log(`Bot is running for ${Math.round(onlineTime / 60)}h ${onlineTime % 60}min.`);
        break;

      case 'listplayers':
        if(bot != null && bot.isOnline()) {
          const list = Object.keys(bot.client.players);
          log('Online players ('+list.length+'): '+list.join(', '));
        } else {
          log('Bot is not connected to server.');
        }
        break;

      case 'citybuild':
        if(bot != null && bot.isOnline()) {
          if(args.length == 1) {
            log('Your current CityBuild: '+currentCityBuild);
          } else if(args.length >= 2) {
            if(!connectingToCityBuild) {
              connectingToCityBuild = true;
              let connectErrorCount = 0;
              while(connectErrorCount < cityBuildConnectLimit && connectingToCityBuild) {
                const result: any = await connectToCitybuild(args[1]);
                if(result.success) {
                  connectingToCityBuild = false;
                  log(`Connected to CityBuild ${currentCityBuild.replace('CB', '')}.`);

                  // execute command if defined
                  if(args.length >= 3) {
                    setTimeout(() => {
                      let command = args.splice(2).join(' ');
                      if(command.startsWith('/')) {
                        command = command.replace('/', '');
                      }
                      bot.sendCommand(command);
                    }, 2000);
                  }
                } else {
                  connectErrorCount++;
                  if(result.error.startsWith('There is no CityBuild named')) {
                    log(result.error);
                    connectingToCityBuild = false;
                  } else {
                    log('Couldn\'t connect to CityBuild: '+result.error);
                  }
                }
              }
              if(connectErrorCount >= cityBuildConnectLimit) {
                log('CityBuild connect limit exceeded!');
              }
            } else {
              log('Already connecting to citybuild. Please wait...');
            }
          } else {
            log('Usage: #citybuild [cb name]');
          }
        } else {
          log('Bot is not connected to server.');
        }
        break;

      case 'authorise':
        if(args.length == 2) {
          if(!config.authorisedPlayers.includes(args[1])) {
            config.authorisedPlayers.push(args[1]);
            log('Authorised the player '+args[1]+'.');
          } else {
            log('The player is already authorised.');
          }
        } else {
          log('Usage: #authorise <name>');
        }
        break;

      case 'unauthorise':
        if(args.length == 2) {
          if(config.authorisedPlayers.includes(args[1])) {
            config.authorisedPlayers = config.authorisedPlayers.filter(e => e !== args[1]);
            log('Removed the player '+args[1]+'.');
          } else {
            log('The player is not authorised.');
          }
        } else {
          log('Usage: #unauthorise <name>');
        }
        break;

      case 'listauthorised':
        log('Authorised players: '+config.authorisedPlayers.join(', '));
        break;

      case 'dropinv':
        if(bot != null && bot.isOnline()) {
          dropInventory();
        } else {
          log('Bot is not connected to server.');
        }
        break;
        
      case 'listinv':
        if(bot != null && bot.isOnline()) {
          if(bot.client.inventory.items().length > 0) {
            log('Inventory:');
            bot.client.inventory.items().forEach(item => {
              log(`Slot ${item.slot} - ${item.count}x ${item.displayName} (${item.type}:${item.metadata})`);
            });
          } else {
            log('Bots inventory is empty.');
          }
        } else {
          log('Bot is not connected to server.')
        }
        break;

      case 'reloadconfig':
        loadConfig();
        log('Configuration reloaded.');
        break;

      case 'income':
        log('Income since login: $'+income);
        break;

      default:
        log('Unknown command "#'+args[0]+'". View available commands with #help');
    }
  } else {
    // minecraft chat
    if(bot != null && bot.isOnline()) {
      bot.sendChat(msg);
    } else {
      log('Bot is not connected to server.');
    }
  }
});


function log(message: string, display: Boolean = true) {
  const time = dateFormat(new Date(), 'HH:MM:ss');
  message = '['+time+'] '+message;
  if(display) console.log(message);
  if(config.logMessages) fs.appendFileSync(logFile, message.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')+'\n');
}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}