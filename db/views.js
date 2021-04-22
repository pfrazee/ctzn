import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import * as db from './index.js'
import { constructUserUrl, constructEntryUrl, isHyperUrl, parseEntryUrl } from '../lib/strings.js'
import { fetchUserId } from '../lib/network.js'
import * as dbGetters from './getters.js'
import * as schemas from '../lib/schemas.js'
import * as errors from '../lib/errors.js'
import { listHomeFeed, listDbmethodFeed, listFollowsOnlyFeed } from './feed-getters.js'
import { fetchNotications, countNotications, dbGet, fetchItemClass, fetchReactions, addPrefixToRangeOpts } from './util.js'

const DEFAULT_USER_AVATAR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'static', 'img', 'default-user-avatar.jpg')
const DEFAULT_COMMUNITY_AVATAR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'static', 'img', 'default-community-avatar.jpg')
const DEFAULT_ITEM_CLASS_ICON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'static', 'img', 'default-item-class-icon.svg')

// globals
// =

const _views = new Map()

// exported api
// =

export function getType (schemaId) {
  const view = _views.get(schemaId)
  if (!view) return undefined
  return view.schema?.schemaObject?.type
}

export async function exec (schemaId, auth, ...args) {
  const view = _views.get(schemaId)
  if (!view) {
    throw new Error(`View "${schemaId}" not found`)
  }
  view.validateParameters.assert(args)
  const res = await view.fn(auth, ...args)
  if (res) view.validateResponse.assert(res)
  return res
}

export function setup () {
  define('ctzn.network/avatar-view', async (auth, userId) => {
    let userDb
    try {
      userId = await fetchUserId(userId)
      userDb = db.publicDbs.get(userId)
      if (!userDb) throw 'Not found'
      
      const ptr = await userDb.blobs.getPointer('avatar')
      if (!ptr) throw 'Not found'

      return {
        ptr,
        etag: `W/block-${ptr.start}`,
        mimeType: ptr.mimeType,
        createStream: () => userDb.blobs.createReadStreamFromPointer(ptr)
      }
    } catch (e) {
      if (userDb?.dbType === 'ctzn.network/public-community-db') {
        return {
          ptr: null,
          etag: `W/default-community-avatar`,
          mimeType: 'image/jpeg',
          createStream: () => fs.createReadStream(DEFAULT_COMMUNITY_AVATAR_PATH)
        }
      } else {
        return {
          ptr: null,
          etag: `W/default-citizen-avatar`,
          mimeType: 'image/jpeg',
          createStream: () => fs.createReadStream(DEFAULT_USER_AVATAR_PATH)
        }
      }
    }
  })

  define('ctzn.network/blob-view', async (auth, userId, blobname) => {
    userId = await fetchUserId(userId)
    const userDb = db.publicDbs.get(userId)
    if (!userDb) throw 'Not found'
    
    const ptr = await userDb.blobs.getPointer(blobname)
    if (!ptr) throw 'Not found'

    return {
      ptr,
      etag: `W/block-${ptr.start}`,
      mimeType: ptr.mimeType,
      createStream: () => userDb.blobs.createReadStreamFromPointer(ptr)
    }
  })

  define('ctzn.network/comment-view', async (auth, userId, commentKey) => {
    if (!commentKey && isHyperUrl(userId)) {
      let {origin, schemaId, key} = parseEntryUrl(userId)
      if (schemaId !== 'ctzn.network/comment') {
        return undefined
      }
      userId = await fetchUserId(origin)
      commentKey = key
    } else {
      userId = await fetchUserId(userId)
    }
    const commentDb = getDb(userId)
    return dbGetters.getComment(commentDb, commentKey, userId, auth)
  })

  define('ctzn.network/community-user-permission-view', async (auth, communityId, citizenId, permId) => {
    communityId = await fetchUserId(communityId)
    citizenId = await fetchUserId(citizenId)
    const communityDb = getDb(communityId)
    const memberRecord = await communityDb.members.get(citizenId)
    if (!memberRecord) return undefined
    if (memberRecord.value.roles?.includes('admin')) {
      return {permId: 'ctzn.network/perm-admin'}
    }
    const roleRecords = await Promise.all(memberRecord.value.roles?.map(roleId => communityDb.roles.get(roleId)) || [])
    for (let roleRecord of roleRecords) {
      const perm = roleRecord.value.permissions?.find(p => p.permId === permId)
      if (perm) return perm
    }
    return undefined
  })

  define('ctzn.network/community-user-permissions-view', async (auth, communityId, citizenId) => {
    communityId = await fetchUserId(communityId)
    citizenId = await fetchUserId(citizenId)
    const communityDb = getDb(communityId)
    const memberRecord = await communityDb.members.get(citizenId)
    if (!memberRecord) return {permissions: []}
    if (memberRecord.value.roles?.includes('admin')) {
      return {permissions: [{permId: 'ctzn.network/perm-admin'}]}
    }
    const roleRecords = await Promise.all(memberRecord.value.roles?.map(roleId => communityDb.roles.get(roleId)) || [])
    return {permissions: roleRecords.map(roleRecord => roleRecord.value.permissions || []).flat()}
  })

  define('ctzn.network/dbmethod-calls-view', async (auth, databaseId, opts) => {
    databaseId = await fetchUserId(databaseId)
    const callsDb = getDb(databaseId)
    const table = callsDb.getTable('ctzn.network/dbmethod-call')
    const entries = await table.list(getListOpts(opts))
    for (let entry of entries) {
      entry.url = table.constructEntryUrl(entry.key)
      let resultUrl = constructEntryUrl(entry.value.database.dbUrl, 'ctzn.network/dbmethod-result', entry.url)
      entry.result = (await dbGet(resultUrl))?.entry
      if (entry.result) {
        entry.result.url = resultUrl
      }
    }
    return {calls: entries}
  })

  define('ctzn.network/dbmethod-feed-view', async (auth, opts) => {
    return {feed: await listDbmethodFeed(opts, auth)}
  })

  define('ctzn.network/dbmethod-results-view', async (auth, databaseId, opts) => {
    databaseId = await fetchUserId(databaseId)
    const resultsDb = getDb(databaseId)
    const resultsIdx = db.publicServerDb.getTable('ctzn.network/dbmethod-result-chron-idx')
    const resultsTable = resultsDb.getTable('ctzn.network/dbmethod-result')
    const idxEntries = await resultsIdx.list(addPrefixToRangeOpts(databaseId, getListOpts(opts)))
    return {
      results: await Promise.all(idxEntries.map(async (idxEntry) => {
        const resultEntry = await resultsTable.get(idxEntry.value.resultKey)
        if (!resultEntry) return undefined
        resultEntry.key = idxEntry.value.idxkey
        resultEntry.url = resultsTable.constructEntryUrl(resultEntry.key)
        resultEntry.call = (await dbGet(resultEntry.value.call.dbUrl))?.entry
        if (resultEntry.call) {
          resultEntry.call.url = resultEntry.value.call.dbUrl
        }
        return resultEntry
      }))
    }
  })

  define('ctzn.network/feed-view', async (auth, opts) => {
    if (!!opts.followOnly) {
      return {feed: await listFollowsOnlyFeed(opts, auth)}
    }
    return {feed: await listHomeFeed(opts, auth)}
  })

  define('ctzn.network/followers-view', async (auth, userId) => {
    userId = await fetchUserId(userId)
    return dbGetters.listFollowers(userId, auth)
  })

  define('ctzn.network/item-class-icon-view', async (auth, userId, classId) => {
    try {
      const userDb = db.publicDbs.get(await fetchUserId(userId))
      if (!userDb) throw 'Not found'

      const itemClassEntry = await userDb.getTable('ctzn.network/item-class').get(classId)
      if (!itemClassEntry) throw 'Not found'
      
      const ptr = await userDb.blobs.getPointer(itemClassEntry.value.iconBlobName)
      if (!ptr) throw 'Not found'

      return {
        ptr,
        etag: `W/block-${ptr.start}`,
        mimeType: ptr.mimeType,
        createStream: () => userDb.blobs.createReadStreamFromPointer(ptr)
      }
    } catch (e) {
      return {
        ptr: null,
        etag: `W/default-item-class-icon`,
        mimeType: 'image/svg+xml',
        createStream: () => fs.createReadStream(DEFAULT_ITEM_CLASS_ICON_PATH)
      }
    }
  })

  define('ctzn.network/notifications-view', async (auth, opts) => {
    if (!auth) throw new errors.SessionError()
    return {notifications: await fetchNotications(auth, opts)}
  })

  define('ctzn.network/notifications-cleared-at-view', async (auth) => {
    if (!auth) throw new errors.SessionError()
    const accountRecord = await db.privateServerDb.accounts.get(auth.username)
    if (!accountRecord) throw new errors.NotFoundError('User account record not found')
    return {notificationsClearedAt: accountRecord.value.notificationsClearedAt || undefined}
  })

  define('ctzn.network/notifications-count-view', async (auth, opts) => {
    if (!auth) throw new errors.SessionError()
    return {count: await countNotications(auth, opts)}
  })

  define('ctzn.network/owned-items-view', async (auth, userId, opts) => {
    const itemClassCache = {}
    userId = await fetchUserId(userId)
    const table = db.publicServerDb.getTable('ctzn.network/owned-items-idx')
    const idxEntries = await table.list(addPrefixToRangeOpts(userId, getListOpts(opts)))
    const itemEntries = await Promise.all(idxEntries.map(async (idxEntry) => {
      const itemEntry = (await dbGet(idxEntry.value.item.dbUrl))?.entry
      if (itemEntry) {
        itemEntry.databaseId = idxEntry.value.item.userId
        itemEntry.url = idxEntry.value.item.dbUrl
        itemEntry.itemClass = await fetchItemClass(itemEntry.databaseId, itemEntry.value.classId, itemClassCache).catch(e => undefined)
      }
      return itemEntry
    }))
    return {items: itemEntries.filter(Boolean)}
  })

  define('ctzn.network/reactions-to-view', async (auth, subjectUrl) => {
    const subject = await dbGet(subjectUrl).catch(e => undefined)
    const subjectEntry = subject ? subject.entry : {}
    if (subject) subjectEntry.author = {userId: subject.db.userId, dbUrl: subject.db.url}
    subjectEntry.url = subjectUrl
    const res = await fetchReactions(subjectEntry)
    return {subject: res.subject, reactions: res.reactions}
  })

  define('ctzn.network/post-view', async (auth, userId, postKey) => {
    if (!postKey && isHyperUrl(userId)) {
      let {origin, schemaId, key} = parseEntryUrl(userId)
      if (schemaId !== 'ctzn.network/post') {
        return undefined
      }
      userId = await fetchUserId(origin)
      postKey = key
    } else {
      userId = await fetchUserId(userId)
    }
    return dbGetters.getPost(getDb(userId), postKey, userId, auth)
  })

  define('ctzn.network/posts-view', async (auth, userId, opts) => {
    userId = await fetchUserId(userId)
    return {posts: await dbGetters.listPosts(getDb(userId), getListOpts(opts), userId, auth)}
  })

  define('ctzn.network/profile-view', async (auth, userId) => {
    userId = await fetchUserId(userId)
    const profileDb = getDb(userId)
    const profileEntry = await profileDb.profile.get('self')
    if (!profileEntry) {
      throw new Error('User profile not found')
    }
    return {
      url: constructUserUrl(userId),
      userId: userId,
      dbUrl: profileDb.url,
      dbType: profileDb.dbType,
      value: profileEntry.value
    }
  })

  define('ctzn.network/thread-view', async (auth, url) => {
    return {comments: await dbGetters.getThread(url, auth)}
  })
}

// internal methods
// =

function define (schemaId, fn) {
  const schema = schemas.get(schemaId)
  if (!schema) throw new Error(`View schema "${schemaId}" not found`)
  const s = schema.schemaObject
  let validateParameters
  let validateResponse
  try {
    validateParameters = s.parameters ? schemas.createValidator(s.parameters) : {assert: noop}
    validateResponse = s.definition ? schemas.createValidator(s.definition) : {assert: noop}
  } catch (e) {
    console.error('Error while compiling view schema:', schemaId)
    console.error(e)
    process.exit(1)
  }
  _views.set(schemaId, {
    validateParameters,
    validateResponse,
    schema,
    fn
  })
}

function getListOpts (listOpts = {}) {
  const opts = {}
  if (listOpts.limit) opts.limit = listOpts.limit
  if (listOpts.lt) opts.lt = listOpts.lt
  if (listOpts.lte) opts.lte = listOpts.lte
  if (listOpts.gt) opts.gt = listOpts.gt
  if (listOpts.gte) opts.gte = listOpts.gte
  if (listOpts.reverse) opts.reverse = true
  return opts
}

function getDb (userId) {
  const publicDb = db.publicDbs.get(userId)
  if (!publicDb) throw new Error('User database not found')
  return publicDb
}

function noop () {}