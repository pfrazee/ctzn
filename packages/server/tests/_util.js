import { create as createApi } from '@bluelinklabs/ctzn-api-client'
import tmp from 'tmp-promise'
import { parseEntryUrl, DEBUG_MODE_PORTS_MAP } from '../lib/strings.js'
import { spawn } from 'child_process'
import * as path from 'path'
import { fileURLToPath } from 'url'

const INSPECTOR_ENABLED = false

let nServer = 1
export async function createServer () {
  const tmpdir = await tmp.dir({unsafeCleanup: true})
  const domain = `dev${nServer++}.localhost`
  const port = DEBUG_MODE_PORTS_MAP[domain]
  console.log('Storing config in', tmpdir.path)

  const binPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin.js')
  const serverProcess = spawn(
    'node',
    [binPath, 'start-test', '--configDir', tmpdir.path, '--domain', domain],
    {
      stdio: [process.stdin, process.stdout, process.stderr],
      env: INSPECTOR_ENABLED ? Object.assign({}, process.env, {NODE_OPTIONS: `--inspect=localhost:${5555+nServer}`}) : undefined
    }
  )

  const api = createApi(`http://localhost:${port}`)
  let isReady = false
  for (let i = 0; i < 15; i++) {
    isReady = await api.get('debug/when-server-ready').then(() => true, () => false)
    if (isReady) break
    await new Promise(r => setTimeout(r, 1e3))
  }
  if (!isReady) throw new Error('Server failed to start')

  return {
    url: `http://localhost:${port}/`,
    domain,
    api,
    process: serverProcess,
    close: async () => {
      const p = new Promise(r => {
        if (serverProcess.exitCode !== null) r()
        serverProcess.on('exit', r)
      })
      serverProcess.kill()
      await p
      await tmpdir.cleanup()
    }
  }
}

export class TestFramework {
  constructor () {
    this.users = {}
  }

  async createCitizen (inst, username) {
    const user = new TestCitizen(inst, username)
    await user.setup()
    this.users[username] = user
    return user
  }

  async createCommunity (inst, username) {
    const user = new TestCommunity(inst, username)
    await user.setup()
    this.users[username] = user
    return user
  }

  testFeed (t, entries, desc) {
    t.is(entries.length, desc.length)
    for (let i = 0; i < desc.length; i++) {
      this.testPost(t, entries[i], desc[i])
    }
  }

  testPost (t, entry, desc) {
    const user = desc[0]
    t.truthy(entry.dbUrl.startsWith(user.profile.dbUrl))
    t.is(entry.author.dbKey, user.dbKey)
    t.is(entry.value.text, desc[1])
  }

  testComment (t, entry, desc, reply) {
    const user = desc[0]
    t.truthy(entry.dbUrl.startsWith(user.profile.dbUrl))
    t.is(entry.author.dbKey, user.dbKey)
    t.is(entry.value.text, desc[1])
    t.is(entry.value.reply.root.dbUrl, reply.root.dbUrl)
    if (reply.parent) t.is(entry.value.reply.parent.dbUrl, reply.parent.dbUrl)
  }

  testThread (t, entries, descs) {
    t.is((entries?.length || 0), (descs?.length || 0), `expected ${descs?.length} entries\n${threadDescToString(descs)}`)
    for (let i = 0; i < descs.length; i++) {
      let entry = entries.find(e => e.value.text === descs[i][1])
      this.testThreadItem(t, entry, descs[i])
    }
  }

  testThreadItem (t, entry, desc) {
    const user = desc[0]
    t.is(entry.author.dbKey, user.dbKey, `expected author dbKey to be ${user.dbKey}\n${commentDescToString(desc)}`)
    t.is(entry.value.text, desc[1], `expected comment text to be ${desc[1]}\n${commentDescToString(desc)}`)

    if (desc[2] && desc[2].length) {
      this.testThread(t, entry.replies, desc[2])
    }
  }

  testFollows (t, entries, users) {
    t.is(entries.length, users.length, `expected ${users.length} follows ${users.map(u=>u.dbKey).join(', ')} got ${entries.map(e=>e.value.subject.dbKey).join(', ')}`)
    for (let user of users) {
      t.is(
        entries.find(f => f.value.subject.dbKey === user.dbKey).value.subject.dbKey,
        user.profile.dbKey,
        `expected to be following ${user.username}`
      )
    }
  }

  testFollowers (t, followers, users) {
    t.is(followers.length, users.length)
    for (let user of users) {
      t.truthy(followers.includes(user.dbKey))
    }
  }

  listFollowers (user) {
    let followers = []
    for (let username in this.users) {
      if (this.users[username].following[user.dbKey]) {
        followers.push(this.users[username])
      }
    }
    return followers
  }

  get allPosts () {
    return Object.values(this.users).map(user => user.posts).flat()
  }

  get allComments () {
    return Object.values(this.users).map(user => user.comments).flat()
  }

  get allSubjects () {
    return [this.allPosts, this.allComments].flat()
  }

  getRandomSubject () {
    const subjects = this.allSubjects
    return subjects[randRange(0, subjects.length - 1)]
  }

  getRandomPost () {
    const posts = this.allPosts
    return posts[randRange(0, posts.length - 1)]
  }
  
  async getRandomParentFor (inst, post) {
    if (randRange(0, 1) === 0) return undefined // 1/2 chance of no parent
    if (Array.isArray(inst)) {
      inst = inst[randRange(0, inst.length - 1)]
    }
    let comments = flattenThread((await inst.api.view.get('ctzn.network/views/thread', {dbUrl: post.dbUrl})).comments)
    return comments[randRange(0, comments.length - 1)]
  }
  
  getExpectedHomeFeedUrls (user) {
    let users = [user].concat(Object.values(user.following))
    let posts = users.map(user => user.posts).flat()
    posts.sort((a, b) => (new Date(b.value.createdAt)) - (new Date(a.value.createdAt)))
    return posts.map(p => p.dbUrl)
  }
  
  getExpectedUserFeedUrls (user) {
    return user.posts.slice().map(p => p.dbUrl)
  }

  getExpectedReactorIds (subject, reaction) {
    var ids = []
    for (let username in this.users) {
      if (this.users[username].reactions[subject.dbUrl][reaction]) {
        ids.push(this.users[username].dbKey)
      }
    }
    return ids
  }

  getThread (post, filterFn) {
    const comments = this.allComments.filter(c => {
      return (c.value.reply.root.dbUrl === post.dbUrl && (!filterFn || filterFn(c)))
    })
    return commentEntriesToThread(comments) || []
  }

  testNotifications (t, entries, descs) {
    t.is(entries.length, descs.length)
    for (let i = 0; i < descs.length; i++) {
      const itemDesc = `notification ${i}`
      const entry = entries[i]
      const desc = descs[i]
      t.is(entry.author.dbKey, desc[0].dbKey, itemDesc)
      
      const {schemaId} = parseEntryUrl(entry.itemUrl)
      switch (desc[1]) {
        case 'follow':
          t.is(schemaId, 'ctzn.network/follow', itemDesc)
          t.is(entry.item.subject.dbKey, desc[2].dbKey, itemDesc)
          break
        case 'comment':
          t.is(schemaId, 'ctzn.network/comment', itemDesc)
          t.is(entry.item.text, desc[2].text, itemDesc)
          t.is(entry.item.reply.root.dbUrl, desc[2].reply.root.dbUrl, itemDesc)
          if (desc[2].reply.parent) t.is(entry.item.reply.parent.dbUrl, desc[2].reply.parent.dbUrl, itemDesc)
          else t.falsy(entry.item.reply.parent, itemDesc)
          break
        case 'reaction':
          t.is(schemaId, 'ctzn.network/reaction', itemDesc)
          t.is(entry.item.reaction, desc[3], itemDesc)
          t.is(entry.item.subject.dbUrl, desc[2].dbUrl, itemDesc)
          break
      }
    }
  }
}

class TestCitizen {
  constructor (inst, username) {
    this.inst = inst
    this.username = username
    this.dbKey = undefined
    this.posts = []
    this.comments = []
    this.following = {}
    this.reactions = {}
  }

  get replies () {
    return this.comments.filter(p => !!p.value.reply)
  }

  async setup () {
    const res = await this.inst.api.post('debug/create-user', {
      type: 'citizen',
      username: this.username,
      email: `${this.username}@email.com`,
      password: 'password',
      profile: {
        displayName: this.username.slice(0, 1).toUpperCase() + this.username.slice(1)
      }
    })
    this.dbKey = res.dbKey
    this.profile = await this.inst.api.view.get('ctzn.network/views/profile', {dbId: res.dbKey})
  }

  async login () {
    await this.inst.api.method('ctzn.network/methods/login', {username: this.username, password: 'password'})
  }

  async updateProfile (profile) {
    await this.login()
    await this.inst.api.table.create(
      this.username,
      'ctzn.network/profile',
      profile
    )
    this.profile = await this.inst.api.view.get('ctzn.network/views/profile', {dbId: this.dbKey})
  }

  async createPost ({audience, text}) {
    await this.login()
    const {dbUrl} = await this.inst.api.table.create(
      this.username,
      'ctzn.network/post',
      {audience, text, createdAt: (new Date()).toISOString()}
    )
    this.posts.push(await this.inst.api.view.get('ctzn.network/views/post', {dbUrl}))
    return this.posts[this.posts.length - 1]
  }

  async createComment ({text, reply}) {
    await this.login()
    if (reply) {
      reply.root = {dbUrl: reply.root.dbUrl}
      if (reply.parent) {
        reply.parent = {dbUrl: reply.parent.dbUrl}
      }
    }
    const {dbUrl} = await this.inst.api.table.create(
      this.username,
      'ctzn.network/comment',
      {text, reply}
    )
    this.comments.push(await this.inst.api.view.get('ctzn.network/views/comment', {dbUrl}))
    return this.comments[this.comments.length - 1]
  }

  async follow (testCitizen) {
    await this.login()
    await this.inst.api.table.create(this.dbKey, 'ctzn.network/follow', {
      subject: {dbKey: testCitizen.dbKey}
    })
    this.following[testCitizen.dbKey] = testCitizen
  }

  async unfollow (testCitizen) {
    await this.login()
    await this.inst.api.table.delete(this.dbKey, 'ctzn.network/follow', testCitizen.dbKey)
    delete this.following[testCitizen.dbKey]
  }

  async react ({subject, reaction}) {
    await this.login()
    await this.inst.api.table.create(
      this.username,
      'ctzn.network/reaction',
      {
        subject: {dbUrl: subject.dbUrl},
        reaction
      }
    )
    this.reactions[subject.dbUrl] = this.reactions[subject.dbUrl] || {}
    this.reactions[subject.dbUrl][reaction] = true
  }

  async unreact ({subject, reaction}) {
    await this.login()
    await this.inst.api.table.delete(this.dbKey, 'ctzn.network/reaction', `${reaction}:${subject.dbUrl}`)
    delete this.reactions[subject.dbUrl][reaction]
  }

  async testSocialGraph (t, sim) {
    let follows = (await this.inst.api.table.list(this.dbKey, 'ctzn.network/follow')).entries
    sim.testFollows(t, follows, Object.values(this.following))
    let followers = (await this.inst.api.view.get('ctzn.network/views/followers', {dbId: this.dbKey})).followers
    sim.testFollowers(t, followers, sim.listFollowers(this))
  }
}

export function randRange (min, max) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function flattenThread (thread, comments = []) {
  for (let comment of thread) {
    comments.push(comment)
    if (comment.replies?.length) {
      flattenThread(comment.replies, comments)
    }
  }
  return comments
}

function commentEntriesToThread (commentEntries) {
  commentEntries = JSON.parse(JSON.stringify(commentEntries)) // deep clone

  const commentEntriesByUrl = {}
  commentEntries.forEach(commentEntry => { commentEntriesByUrl[commentEntry.dbUrl] = commentEntry })

  const rootCommentEntries = []
  commentEntries.forEach(commentEntry => {
    if (commentEntry.value.reply?.parent) {
      let parent = commentEntriesByUrl[commentEntry.value.reply.parent.dbUrl]
      if (!parent) {
        commentEntry.isMissingParent = true
        rootCommentEntries.push(commentEntry)
        return
      }
      if (!parent.replies) {
        parent.replies = []
        parent.replyCount = 0
      }
      parent.replies.push(commentEntry)
      parent.replyCount++
    } else {
      rootCommentEntries.push(commentEntry)
    }
  })
  return rootCommentEntries
}

export function threadDescToString (descs, prefix = '') {
  let items = []
  for (let desc of descs) {
    items.push(`${prefix}${desc[0].username} ${desc[1]}`)
    if (desc[2]) items = items.concat(threadDescToString(desc[2], `  ${prefix}`))
  }
  return items.join('\n')
}

function commentDescToString (desc, prefix = '') {
  let items = []
  items.push(`${prefix}${desc[0].username} ${desc[1]}`)
  if (desc[2]) items = items.concat(threadDescToString(desc[2], `  ${prefix}`))
  return items.join('\n')
}