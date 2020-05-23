const fs = require('fs')
const path = require('path')

const moment = require('moment-timezone')
const fetch = require('node-fetch')

const Discord = require('discord.js')
const client = new Discord.Client()

const settings = require('./settings.js')

const translations = {}
const translationsDir = fs.readdirSync(path.join(__dirname, 'i18n'))
translationsDir.forEach(i => {
  const name = i.replace('.json', '')
  translations[name] = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', i)))
})
const translate = translations.english

if (!settings.discord.token) throw new Error(translate.noDiscordToken)
if (!settings.twitch.clientID) throw new Error(translate.noTwitchClientID)
if (!settings.twitch.clientSecret) {
  console.log(translate.updatingFromPreviousIncludeTwitchClientSecret)
  throw new Error(translate.noTwitchClientSecret)
}

// Create data.json if it doesn't exist.
if (!fs.existsSync(path.join(__dirname, 'data.json'))) {
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify({ guilds: {} }, null, 2))
  console.log(translate.createdDataJSON)
}
const tokenFilePath = path.join(__dirname, 'token.json')

let data = require('./data.json')

// https://stackoverflow.com/a/55435856
function chunks (arr, n) {
  function * ch (arr, n) {
    for (let i = 0; i < arr.length; i += n) {
      yield (arr.slice(i, i + n))
    }
  }

  return [...ch(arr, n)]
}

// [{ guild: id, entry: 'entry', value: 'value'}]
function saveData (d = [{ guild: '', entry: '', action: '', value: 'any' }]) {
  const dataOnFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json')))
  for (let index = 0; index < d.length; index++) {
    const object = d[index]
    try {
      switch (object.action) {
        case 'push':
          dataOnFile.guilds[object.guild][object.entry].push(object.value)
          break
        case 'splice':
          dataOnFile.guilds[object.guild][object.entry].splice(object.value[0], object.value[1])
          break
        case 'addGuild':
          dataOnFile.guilds[object.guild] = defaultGuildData
          break
        case 'removeGuild':
          dataOnFile.guilds[object.guild] = undefined
          break
        default:
          dataOnFile.guilds[object.guild][object.entry] = object.value
          break
      }
    } catch (e) {
      console.error(e)
    }
  }
  data = dataOnFile
  return fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(dataOnFile, null, 2))
}

const cache = {}
const initialization = new Date()
const defaultGuildData = {
  streamers: [],
  announcementChannel: null,
  reactions: [],
  message: '@everyone %name% **%status%**!',
  time: { locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  prefix: '!',
  language: settings.language || 'english'
}

let disconnect = false
let headers = new fetch.Headers({})
let tokenExpirationDate

async function refreshAppToken () {
  let tokenJSON

  if (typeof tokenExpirationDate !== 'number' && fs.existsSync(tokenFilePath)) {
    try {
      tokenJSON = JSON.parse(fs.readFileSync(tokenFilePath))
      tokenExpirationDate = tokenJSON.expiration

      console.log(translate.usingExistingToken, new Date(tokenJSON.expiration).toUTCString())
      headers = new fetch.Headers({
        Authorization: `Bearer ${tokenJSON.superSecret}`,
        'Client-ID': settings.twitch.clientID
      })

      // Validate token
      try {
        const res = await fetch('https://id.twitch.tv/oauth2/validate', {
          headers: new fetch.Headers({
            Authorization: `OAuth ${tokenJSON.superSecret}`
          })
        }).then(res => res.json())

        if (res.client_id !== settings.twitch.clientID) throw new Error('Missmatch')
      } catch (err) {
        if (err.message === 'Missmatch') console.log(translate.missmatchToken)
        console.log(translate.invalidTokenResponse)
        tokenExpirationDate = 0
      }
    } catch (e) {
      tokenExpirationDate = Date.now() - 1
    }
  }

  if (Date.now() >= (tokenExpirationDate || 0)) {
    try {
      const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${settings.twitch.clientID}&client_secret=${settings.twitch.clientSecret}&grant_type=client_credentials`, { method: 'POST' }).then(res => res.json())

      const expirationDate = Date.now() + (res.expires_in * 1000)

      headers = new fetch.Headers({
        Authorization: `Bearer ${res.access_token}`,
        'Client-ID': settings.twitch.clientID
      })

      console.log(translate.wroteTokenToDisk)
      fs.writeFileSync(tokenFilePath, JSON.stringify({
        expiration: expirationDate,
        superSecret: res.access_token
      }))

      tokenExpirationDate = expirationDate
    } catch (err) {
      console.log(translate.genericTokenError)
      console.error(err)
      return false
    }
  }

  return true
}

class Message {
  constructor (message) {
    this.cmd = message.content.replace(new RegExp(`^<@${client.user.id}> `), '!').split(/[ ]+/)
    this.discord = message
    this.gid = message.guild.id
    this.prefix = data.guilds[this.gid].prefix || '!'
  }
}

class Command {
  constructor ({ helpText, commandNames, handler }) {
    this.helpText = helpText // String or Function
    this.commandNames = commandNames // Array
    this.handler = handler // Function
  }

  showHelpText (message) {
    return typeof this.helpText === 'function' ? this.helpText(message) : this.helpText
  }
}

const commands = (translate) => [
  new Command({
    commandNames: translate.commands.help.triggers,
    helpText: (message) => {
      return translate.commands.help.helpText.replace('%1', message.prefix)
    },
    handler: async (message) => {
      // Help command.
      if (message.cmd[1]) {
        const command = commands(translate).find(command => command.commandNames.indexOf(message.cmd[1].toLowerCase()) > -1)
        return message.discord.reply(command ? typeof command.helpText === 'function' ? command.helpText(message) : command.helpText : 'that command does not exist.')
      } else {
        try {
          const embed = new Discord.MessageEmbed()
            .setTitle(translate.commands.help.availableCommands)
          for (let index = 0; index < commands(translate).length; index++) {
            const cmd = commands(translate)[index]
            embed.addField(cmd.commandNames.join(', '), typeof cmd.helpText === 'function' ? cmd.helpText(message) : cmd.helpText)
          }
          await message.discord.channel.send(translate.commands.help.message, { embed })
        } catch (err) {
          if (err.message === 'Missing Permissions') {
            return message.discord.reply(translate.commands.help.message.concat(commands.map(cmd => `\n${typeof cmd.helpText === 'function' ? cmd.helpText(message) : cmd.helpText}`)))
          }
        }
      }
    }
  }),
  new Command({
    commandNames: translate.commands.uptime.triggers,
    helpText: (message) => {
      return translate.commands.uptime.helpText.replace('%1', message.prefix)
    },
    handler: (message) => {
      // Uptime command.
      const time = Date.now() - initialization
      let seconds = time / 1000
      const hours = parseInt(seconds / 3600)
      seconds = seconds % 3600
      const minutes = parseInt(seconds / 60)
      seconds = seconds % 60
      return message.discord.reply(
        `%1 ${minutes > 0 ? `${hours > 0 ? `${hours} %2,` : ''}${minutes} %3 ` : ''}${seconds.toFixed(0)} %4.\n(%5 ${moment.utc(initialization).locale(data.guilds[message.gid].time.locale).tz(data.guilds[message.gid].time.timeZone).format('LL LTS zz')}.)`
          .replace('%1', translate.commands.uptime.message)
          .replace('%2', translate.commands.uptime.hoursComma)
          .replace('%3', translate.commands.uptime.minutesAnd)
          .replace('%4', translate.commands.uptime.seconds)
          .replace('%5', translate.commands.uptime.onlineSince)
      )
    }
  }),
  new Command({
    commandNames: translate.commands.add.triggers,
    helpText: (message) => {
      return translate.commands.add.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
    },
    handler: async (message) => {
      // Add streamer to cache.
      const streamerName = message.cmd[1] ? message.cmd[1].toLowerCase().split('/').pop() : false
      if (streamerName) {
        if (cache[message.gid].findIndex(s => s.name.toLowerCase() === streamerName) > -1) return message.discord.reply(translate.commands.add.alreadyExists)
        cache[message.gid].push({ name: streamerName })
        saveData([{ guild: message.gid, entry: 'streamers', action: 'push', value: { name: streamerName } }])
        const test = {
          gameInfo: {
            name: translate.commands.add.gameInfoName,
            box_art_url: 'https://static-cdn.jtvnw.net/ttv-boxart/Science%20&%20Technology-{width}x{height}.jpg'
          },
          streamInfo: {
            name: 'twitchdev',
            type: '(DEMO) LIVE/VOD/RERUN...',
            title: translate.commands.add.streamInfoTitle
          }
        }
        try {
          const embed = streamPreviewEmbed(message.gid, { ...test, imageFileName: null })
          embed.setImage('https://static-cdn.jtvnw.net/ttv-static/404_preview-1920x1080.jpg')
          await message.discord.channel.send(parseAnnouncementMessage(message.gid, test), { embed })
        } catch (err) {
          if (err.message === 'Missing Permissions') {
            await message.discord.channel.send(parseAnnouncementMessage(message.gid, test))
          }
        }
        return message.discord.reply(
          `%1 ${data.guilds[message.gid].announcementChannel ? '' : '\n%2'}`
            .replace('%1', translate.commands.add.message)
            .replace('%2', translate.commands.add.addAnnouncementChannel)
        )
      } else return false
    }
  }),
  new Command({
    commandNames: translate.commands.remove.triggers,
    helpText: (message) => {
      return translate.commands.remove.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
    },
    handler: (message) => {
      // Remove streamer from cache.
      const streamerName = message.cmd[1] ? message.cmd[1].toLowerCase().split('/').pop() : false
      if (streamerName) {
        if (cache[message.gid].findIndex(s => s.name.toLowerCase() === streamerName) === -1) return message.discord.reply(translate.commands.remove.doesNotExist)
        cache[message.gid] = cache[message.gid].filter(s => s.name.toLowerCase() !== streamerName)
        saveData([{ guild: message.gid, entry: 'streamers', value: data.guilds[message.gid].streamers.filter(s => s.name !== streamerName) }])
        return message.discord.reply(translate.commands.remove.message)
      } else return false
    }
  }),
  new Command({
    commandNames: translate.commands.channel.triggers,
    helpText: (message) => {
      const discordChannel = message.discord.guild.channels.cache.filter(channel => channel.type === 'text' && channel.memberPermissions(message.discord.guild.me).has('SEND_MESSAGES')).first()
      return translate.commands.channel.helpText
        .replace(/%1/g, translate.example)
        .replace('%2', message.prefix)
        .replace('%3', discordChannel.name)
        .replace('%4', discordChannel.id)
    },
    handler: (message) => {
      // Choose which channel to post live announcements in.
      if (message.cmd[1]) {
        const channelID = message.cmd[1].replace(/[^0-9]/g, '')
        if (message.discord.guild.channels.cache.get(channelID) && message.discord.guild.channels.cache.get(channelID).memberPermissions(message.discord.guild.me).has('SEND_MESSAGES')) {
          saveData([{ guild: message.gid, entry: 'announcementChannel', value: channelID }])
          return message.discord.reply(translate.commands.channel.message)
        } else return message.discord.reply(translate.commands.channel.noPermissionsForChannel)
      } else return false
    }
  }),
  new Command({
    commandNames: translate.commands.operator.triggers,
    helpText: (message) => {
      return translate.commands.operator.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
        .replace('%3', message.discord.author.id)
    },
    handler: (message) => {
      if (message.discord.author.id === message.discord.guild.owner.id) {
        if (message.cmd[1]) {
          const operator = message.cmd[1].replace(/[^0-9]/g, '')
          let added = true
          if (data.guilds[message.gid].operator && data.guilds[message.gid].operator.includes(operator)) {
            added = false
            saveData([{ guild: message.gid, entry: 'operator', action: 'splice', value: [data.guilds[message.gid].operator.indexOf(operator), 1] }])
          } else {
            if (!data.guilds[message.gid].operator) saveData([{ guild: message.gid, entry: 'operator', value: [] }])
            saveData([{ guild: message.gid, entry: 'operator', action: 'push', value: operator }])
          }
          return message.discord.reply(translate.commands.operator.message.replace('%1', added ? translate.added : translate.removed))
        } else return false
      } else return message.discord.reply(translate.commands.operator.noPermission)
    }
  }),
  new Command({
    commandNames: ['react', 'reaction'],
    helpText: (message) => {
      return translate.commands.reaction.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
    },
    handler: (message) => {
      if (message.cmd[1]) {
        let emoji
        if (message.cmd[1].match(/<a?:[\w]+:[0-9]+>/g)) {
          emoji = message.cmd[1].split(':')[2].replace(/[^0-9]/g, '')
        } else emoji = message.cmd[1]
        let added = true
        if (data.guilds[message.gid].reactions.includes(emoji)) {
          added = false
          saveData([{ guild: message.gid, entry: 'reactions', action: 'splice', value: [data.guilds[message.gid].reactions.indexOf(emoji), 1] }])
        } else {
          saveData([{ guild: message.gid, entry: 'reactions', action: 'push', value: emoji }])
        }
        return message.discord.reply(translate.commands.reaction.message.replace('%1', added ? translate.added : translate.removed))
      } else return false
    }
  }),
  new Command({
    commandNames: ['tz', 'timezone'],
    helpText: (message) => {
      return translate.commands.timezone.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
    },
    handler: (message) => {
      if (message.cmd[1]) {
        saveData([{ guild: message.gid, entry: 'time', value: { locale: message.cmd[1], timeZone: data.guilds[message.gid].time.timeZone } }])
        if (message.cmd[2]) {
          saveData([{ guild: message.gid, entry: 'time', value: { locale: data.guilds[message.gid].time.timeZone, timeZone: message.cmd[2] } }])
        }
        return message.discord.reply(translate.commands.timezone.message.replace('%1', moment.utc().locale(data.guilds[message.gid].time.locale).tz(data.guilds[message.gid].time.timeZone).format('LL LTS zz')))
      } else return false
    }
  }),
  new Command({
    commandNames: ['msg', 'message'],
    helpText: (message) => {
      return translate.commands.message.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
    },
    handler: (message) => {
      // Change stream announcement message.
      const cleanedContent = message.cmd.slice(1).join(' ')
      if (cleanedContent.length > 0) {
        saveData([{ guild: message.gid, entry: 'message', value: cleanedContent }])
        return message.discord.reply(translate.commands.message.message)
      } else return false
    }
  }),
  new Command({
    commandNames: ['pfx', 'prefix'],
    helpText: (message) => {
      return translate.commands.prefix.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
    },
    handler: (message) => {
      if (message.cmd[1]) {
        saveData([{ guild: message.gid, entry: 'prefix', value: message.cmd[1] }])
        return message.discord.reply(translate.commands.prefix.message.replace('%1', message.cmd[1]))
      } else return false
    }
  }),
  new Command({
    commandNames: ['language', 'lang'],
    helpText: (message) => {
      return translate.commands.language.helpText
        .replace('%1', translate.example)
        .replace('%2', message.prefix)
        .replace('%3', Object.keys(translations).join(', '))
    },
    handler: (message) => {
      const providedValue = message.cmd[1]
      if (providedValue) {
        if (translations[providedValue.toLowerCase()]) {
          saveData([{ guild: message.gid, entry: 'language', value: message.cmd[1] }])
          return message.discord.reply(translate.commands.language.message.replace('%1', providedValue.toLowerCase()))
        } else return message.discord.reply(translate.commands.language.languageDoesNotExit.replace('%1', Object.keys(translations).join(', ')))
      } else return false
    }
  })
]

async function check () {
  try {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'))) // Reload data json
  } catch (err) {
    console.log(translate.genericDataJSONErrorRetry)
    setTimeout(check, 60000)
    return console.error(err)
  }

  if (disconnect) {
    setTimeout(check, 3000)
    return console.log(translate.disconnectedDiscord)
  }

  const continueBoolean = await refreshAppToken()
  if (!continueBoolean) {
    setTimeout(check, 3000)
    return
  }

  const streamers = new Set()

  const guildIDs = Object.keys(data.guilds)
  for (let i = 0; i < guildIDs.length; i++) {
    const guildID = guildIDs[i]
    if (client.guilds.cache.find(i => i.id === guildID) && data.guilds[guildID].streamers) data.guilds[guildID].streamers.forEach(stream => streamers.add(stream.name))
  }

  if ([...streamers].length < 1) {
    setTimeout(check, typeof settings.timer === 'number' ? settings.timer + 5000 : 61000)
    return console.log(translate.noTwitchChannels)
  }

  try {
    const batches = chunks([...streamers], 100)
    const resData = []
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index]
      const request = await fetch(`https://api.twitch.tv/helix/streams?${batch.map((i, ind) => ind > 0 ? '&user_login=' + i : 'user_login=' + i).join('')}`, { headers })
      const response = await request.json()

      if (response.error) throw response
      else resData.push(...response.data)
    }

    const streams = []
    for (let i = 0; i < resData.length; i++) {
      const stream = resData[i]

      // Deprecated API usage!
      let user = await fetch(`https://api.twitch.tv/kraken/users/${stream.user_id}`, { headers: new fetch.Headers({ Accept: 'application/vnd.twitchtv.v5+json', 'Client-ID': settings.twitch.clientID }) })

      if (user.error) console.error(user.error)
      else user = await user.json()

      streams.push({
        name: stream.user_name.replace(/ /g, ''),
        avatar: user ? user.logo : null,
        gameID: stream.game_id,
        thumbnail: stream.thumbnail_url.replace('{width}x{height}', '1280x720'),
        type: stream.type,
        title: stream.title,
        viewers: stream.viewer_count,
        started: stream.started_at
      })
    }

    const promise = []
    const cachedImages = {}
    if (streams.length > 0) {
      const games = [...new Set(streams.filter(s => s.gameID).map(s => s.gameID))]
      const gamesChunk = chunks(games, 100)
      for (let index = 0; index < gamesChunk.length; index++) {
        const batch = gamesChunk[index]
        promise.push(fetch(`https://api.twitch.tv/helix/games?${batch.map((i, ind) => ind > 0 ? '&id=' + i : 'id=' + i).join('')}`, { headers }).then(res => res.json()))
      }

      for (let index = 0; index < streams.length; index++) {
        const s = streams[index]
        const imageName = s.thumbnail
        const res = await fetch(s.thumbnail).then(res => res.buffer())
        cachedImages[imageName] = res
      }
    }

    const streamedGames = await Promise.all(promise)
    const announcements = []
    for (let index = 0; index < guildIDs.length; index++) {
      const guildID = guildIDs[index]
      if (data.guilds[guildID].announcementChannel) {
        for (let i = 0; i < cache[guildID].length; i++) {
          if (streams.map(s => s.name.toLowerCase()).includes(cache[guildID][i].name ? cache[guildID][i].name.toLowerCase() : '')) {
          // Make sure they've not already been announced.
            const isStreaming = cache[guildID][i].streaming
            const started = streams.find(s => s.name.toLowerCase() === cache[guildID][i].name.toLowerCase()).started
            const lastStartedAt = data.guilds[guildID].streamers.find(s => s.name.toLowerCase() === cache[guildID][i].name.toLowerCase()).lastStartedAt
            if (!isStreaming && new Date(started).getTime() > new Date(lastStartedAt || 0).getTime()) {
              // Push info.
              const streamInfo = streams.find(s => s.name.toLowerCase() === cache[guildID][i].name.toLowerCase())
              const gameInfo = (streamedGames[0] && streamedGames[0].data) ? streamedGames[0].data.find(g => g.id === streamInfo.gameID) : undefined

              cache[guildID][i] = streamInfo
              cache[guildID][i].game = gameInfo
              cache[guildID][i].streaming = true

              data.guilds[guildID].streamers[i].lastStartedAt = cache[guildID][i].started
              saveData([{ guild: guildID, entry: 'streamers', value: data.guilds[guildID].streamers }])

              announcements.push(sendMessage(guildID, { cachedImage: cachedImages[cache[guildID][i].thumbnail], streamInfo, gameInfo })) // Batch announcements.
            }
          } else cache[guildID][i].streaming = false // Not live.
        }
      }
    }

    await Promise.all(announcements) // Send announcements.

    if (announcements.length > 0) console.log(translate.announcedStreams)
    setTimeout(check, typeof settings.timer === 'number' ? settings.timer : 61000)
  } catch (e) {
    if (e.error === 'Too Many Requests') {
      settings.timer += 5000
      setTimeout(check, typeof settings.timer === 'number' ? settings.timer : 61000)
      return console.log(translate.throttledByTwitch, translate.twitchThrottleMessage, e.message)
    } else {
      settings.timer += 60000
      setTimeout(check, typeof settings.timer === 'number' ? settings.timer : 61000)
      return console.error(e)
    }
  }
}

const streamPreviewEmbed = (guildID, { imageFileName, streamInfo, gameInfo }) => {
  const embed = new Discord.MessageEmbed()
    .setColor(0x6441A4)
    .setTitle(`[${streamInfo.type.toUpperCase()}] ${streamInfo.name}`)
    .setDescription(`**${streamInfo.title}**\n${gameInfo ? gameInfo.name : ''}`)
    .setFooter(translate.streamStarted.concat(moment.utc(streamInfo.started).locale(data.guilds[guildID].time.locale).tz(data.guilds[guildID].time.timeZone).format('LL LTS zz')), gameInfo ? gameInfo.box_art_url.replace('{width}x{height}', '32x64') : undefined)
    .setURL(`http://www.twitch.tv/${streamInfo.name}`)

  if (streamInfo.avatar) embed.setThumbnail(streamInfo.avatar)
  if (imageFileName) embed.setImage(`attachment://${imageFileName}`)
  return embed
}

const parseAnnouncementMessage = (guildID, { streamInfo, gameInfo }) => {
  return data.guilds[guildID].message
    .replace('%name%', streamInfo.name)
    .replace('%status%', streamInfo.type.toUpperCase())
    .replace('%game%', gameInfo ? gameInfo.name : translate.unknownGame)
    .replace('%title%', streamInfo.title)
}

async function sendMessage (guildID, { cachedImage, streamInfo, gameInfo }) {
  const imageFileName = `${streamInfo.name}_${Date.now()}.jpg`

  const embed = streamPreviewEmbed(guildID, { imageFileName, streamInfo, gameInfo })

  if (client.channels.cache.get(data.guilds[guildID].announcementChannel)) {
    let message
    const parsedAnnouncementMessage = parseAnnouncementMessage(guildID, { streamInfo, gameInfo })
    try {
      message = await client.channels.cache.get(data.guilds[guildID].announcementChannel).send(`${parsedAnnouncementMessage} http://www.twitch.tv/${streamInfo.name}`, {
        embed, files: [{ attachment: cachedImage, name: imageFileName }]
      })
    } catch (err) {
      console.error(err.name, err.message, err.code, translate.inGuild.concat(client.guilds.cache.get(guildID).name))
      if (err.message === 'Missing Permissions') {
        message = await client.channels.cache.get(data.guilds[guildID].announcementChannel).send(`${parsedAnnouncementMessage} http://www.twitch.tv/${streamInfo.name}`)
      }
    }

    if (data.guilds[guildID].reactions.length > 0) {
      for (let index = 0; index < data.guilds[guildID].reactions.length; index++) {
        const emoji = data.guilds[guildID].reactions[index]
        try {
          if (Number.isInteger(Number(emoji))) await message.react(message.guild.emojis.get(emoji))
          else await message.react(emoji)
        } catch (err) {
          console.error(err.name, err.message, err.code, `in guild ${client.guilds.cache.get(guildID).name}`)
        }
      }
    }

    console.log(translate.announcedInOverAtGuild, streamInfo.name, client.channels.cache.get(data.guilds[guildID].announcementChannel).name, client.guilds.cache.get(guildID).name)
  } else console.log(translate.announcementChannelDoesNotExist, data.guilds[guildID].announcementChannel, client.guilds.cache.get(guildID).name)

  return Promise.resolve()
}

client.on('message', message => {
  let allow = false
  if (message.guild && message.member) {
    // If message comes from a guild and guild member.
    if (data.guilds[message.guild.id].operator && data.guilds[message.guild.id].operator.length > 0) {
      // If server has operators set.
      if (data.guilds[message.guild.id].operator.includes(message.author.id)) {
        // If message is from an operator.
        allow = true
      } else if (message.author.id === message.guild.owner.id) {
        // Or from server owner.
        allow = true
      }
    } else if (message.member.hasPermission((settings.discord.permissionForCommands || 'MANAGE_ROLES'), false, true, true)) {
      // If message from a guild member with the required permission.
      allow = true
    } else if (!message.author.bot && (message.author.id === client.user.id)) {
      // If from myself (aka self-bot) in a guild.
      allow = true
    }
  }
  if (allow) {
    const cleanedMessage = message.content.replace(new RegExp(`^<@${client.user.id}> `), '!')
    if (message.cleanContent.startsWith(data.guilds[message.guild.id].prefix || '!') || message.mentions.users.find(u => u.id === client.user.id)) {
      const command = commands({
        ...translations.english,
        ...translations[data.guilds[message.guild.id].language],
        commands: {
          ...translations.english.commands,
          ...translations[data.guilds[message.guild.id].language].commands
        }
      }).find(command => command.commandNames.indexOf(cleanedMessage.split(/[ ]+/)[0].toLowerCase().substr(data.guilds[message.guild.id].prefix.length)) > -1)
      if (command) command.handler(new Message(message)) || message.reply(command.showHelpText(new Message(message))) // Handle command.
    }
  }
})

client.on('guildCreate', guild => {
  if (!data.guilds[guild.id]) {
    cache[guild.id] = []
    saveData([{ guild: guild.id, action: 'addGuild' }])
    console.log(translate.addedGuild)
  }
})

client.on('guildDelete', guild => {
  if (data.guilds[guild.id]) {
    cache[guild.id] = undefined
    saveData([{ guild: guild.id, action: 'removeGuild' }])
    console.log(translate.removedGuild)
  }
})

client.once('ready', async () => {
  console.log(translate.loggedIntoDiscord)
  if (settings.discord.activity[0].length > 0 && settings.discord.activity[1].length > 0) {
    const possibleActivities = ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING']
    await client.user.setActivity(settings.discord.activity[1], { type: possibleActivities.includes(settings.discord.activity[0].toUpperCase()) ? settings.discord.activity[0].toUpperCase() : 'PLAYING' }).then(() => console.log(translate.activityHasBeenSet)).catch(console.error)
  }

  await client.user.setStatus(client.user.presence.status === 'offline' ? 'online' : client.user.presence.status) // 'online' | 'idle' | 'dnd' | 'invisible'

  client.guilds.cache.forEach(guild => {
    if (!data.guilds[guild.id]) {
      saveData([{ guild: guild.id, action: 'addGuild' }])
    } else {
      if (!data.guilds[guild.id].reactions) saveData([{ guild: guild.id, entry: 'reactions', value: [] }])
      if (!data.guilds[guild.id].time) saveData([{ guild: guild.id, entry: 'time', value: { locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }])
      if (!data.guilds[guild.id].message) saveData([{ guild: guild.id, entry: 'message', value: '@everyone %name% **%status%**!' }])
      if (!data.guilds[guild.id].prefix) saveData([{ guild: guild.id, entry: 'prefix', value: settings.discord.defaultPrefix }])
      if (!data.guilds[guild.id].language) saveData([{ guild: guild.id, entry: 'language', value: settings.language || 'english' }])
    }
  })

  // Initialization of cache.
  const guildIDs = Object.keys(data.guilds)
  for (let index = 0; index < guildIDs.length; index++) {
    const guildID = guildIDs[index]
    const guild = data.guilds[guildID]
    cache[guildID] = []
    for (let i = 0; i < guild.streamers.length; i++) {
      const streamer = guild.streamers[i]
      cache[guildID].push({ name: streamer.name, streaming: false })
    }
  }

  // Starter
  setTimeout(check, typeof settings.timer === 'number' ? settings.timer : 61000)
})

client.on('reconnecting', () => {
  console.log(translate.reconnectingToDiscord)
  disconnect = true
}).on('resume', () => {
  console.log(translate.reconnectedToDiscord)
  disconnect = false
}).on('disconnect', () => {
  disconnect = true
  client.login(settings.discord.token)
}).login(settings.discord.token).catch(e => console.log(e))
