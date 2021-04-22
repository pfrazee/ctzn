import lexint from 'lexicographic-integer-encoding'
import { publicDbs } from './index.js'
import { constructEntryUrl, getServerIdForUserId } from '../lib/strings.js'
import { dbGet, fetchAuthor, fetchReactions, fetchReplyCount, fetchRelatedItemTransfers, addPrefixToRangeOpts } from './util.js'
import * as errors from '../lib/errors.js'

const lexintEncoder = lexint('hex')

export async function listFollowsOnlyFeed (opts, auth) {
  opts = opts && typeof opts === 'object' ? opts : {}
  opts.lt = opts.lt && typeof opts.lt === 'string' ? opts.lt : lexintEncoder.encode(Date.now())

  if (!auth) throw new errors.SessionError()
  const publicDb = publicDbs.get(auth.userId)
  if (!publicDb) throw new errors.NotFoundError('User database not found')

  let followEntries = await publicDb.follows.list()
  followEntries.unshift({value: {subject: auth}})
  const sourceDbs = followEntries.map(f => ({db: publicDbs.get(f.value.subject.userId)}))

  const cursors = sourceDbs.map(({db}) => {
    if (!db) return undefined
    if (db.dbType === 'ctzn.network/public-citizen-db') {
      let res = db.posts.cursorRead({lt: opts?.lt, reverse: true, wait: false})
      return res
    } 
   })

  const postEntries = []
  const authorsCache = {}
  const limit = Math.min(opts?.limit || 99, 100)
  const mergedCursor = mergeCursors(cursors)
  for await (let [db, entry] of mergedCursor) {
    if (entry.value.community) {
      continue // filter out community posts by followed users
    }
    if (!entry) {
      continue // entry not found
    }
    entry.url = constructEntryUrl(db.url, 'ctzn.network/post', entry.key)
    entry.author = await fetchAuthor(db.userId, authorsCache)
    entry.reactions = (await fetchReactions(entry)).reactions
    entry.replyCount = await fetchReplyCount(entry)
    entry.relatedItemTransfers = await fetchRelatedItemTransfers(entry)
    postEntries.push(entry)
    if (postEntries.length >= limit) {
      break
    }
  }

  return postEntries
}

export async function listHomeFeed (opts, auth) {
  opts = opts && typeof opts === 'object' ? opts : {}
  opts.lt = opts.lt && typeof opts.lt === 'string' ? opts.lt : lexintEncoder.encode(Date.now())

  if (!auth) throw new errors.SessionError()
  const publicDb = publicDbs.get(auth.userId)
  if (!publicDb) throw new errors.NotFoundError('User database not found')

  const followEntries = await publicDb.follows.list()
  followEntries.unshift({value: {subject: auth}})
  const membershipEntries = await publicDb.memberships.list()
  const sourceDbs = [
    ...followEntries.map(f => ({db: publicDbs.get(f.value.subject.userId)})),
    ...membershipEntries.map(m => {
      const serverId = getServerIdForUserId(m.value.community.userId)
      return {
        communityId: m.value.community.userId,
        db: publicDbs.get(serverId)
      }
    })
  ]
  
  const cursors = sourceDbs.map(({db, communityId}) => {
    if (!db) return undefined
    if (db.dbType === 'ctzn.network/public-citizen-db') {
      return db.posts.cursorRead({lt: opts?.lt, reverse: true, wait: false})
    } else if (communityId) {
      const cursor = db.feedIdx.cursorRead(addPrefixToRangeOpts(communityId, {lt: opts?.lt, reverse: true}))
      cursor.prefixLength = communityId.length + 1
      return cursor
    }
  })

  const postEntries = []
  const authorsCache = {}
  const limit = Math.min(opts?.limit || 100, 100)
  const mergedCursor = mergeCursors(cursors)
  for await (let [db, entry] of mergedCursor) {
    if (db.dbType === 'ctzn.network/public-server-db') {
      const res = await dbGet(entry.value.item.dbUrl, {
        noLoadExternal: true,
        wait: false
      }).catch(e => undefined)
      if (!res) continue
      entry = res.entry
      db = res.db
    } else {
      if (entry.value.community) {
        continue // filter out community posts by followed users
      }
    }
    if (!entry) {
      continue // entry not found
    }
    entry.url = constructEntryUrl(db.url, 'ctzn.network/post', entry.key)
    entry.author = await fetchAuthor(db.userId, authorsCache)
    entry.reactions = (await fetchReactions(entry)).reactions
    entry.replyCount = await fetchReplyCount(entry)
    entry.relatedItemTransfers = await fetchRelatedItemTransfers(entry)
    postEntries.push(entry)
    if (postEntries.length >= limit) {
      break
    }
  }

  return postEntries
}

export async function listDbmethodFeed (opts, auth) {
  opts = opts && typeof opts === 'object' ? opts : {}
  opts.lt = opts.lt && typeof opts.lt === 'string' ? opts.lt : lexintEncoder.encode(Date.now())

  if (!auth) throw new errors.SessionError()
  const publicDb = publicDbs.get(auth.userId)
  if (!publicDb) throw new errors.NotFoundError('User database not found')

  const followEntries = await publicDb.follows.list()
  followEntries.unshift({value: {subject: auth}})
  const membershipEntries = await publicDb.memberships.list()
  const communityIds = membershipEntries.map(m => m.value.community.userId)
  const sourceDbs = [
    ...followEntries.map(f => ({db: publicDbs.get(f.value.subject.userId)})),
    ...membershipEntries.map(m => {
      const serverId = getServerIdForUserId(m.value.community.userId)
      return {
        communityId: m.value.community.userId,
        db: publicDbs.get(serverId)
      }
    })
  ]
  
  const cursors = sourceDbs.map(({db, communityId}) => {
    if (!db) return undefined
    if (db.dbType === 'ctzn.network/public-citizen-db') {
      return db.dbmethodCalls.cursorRead({lt: opts?.lt, reverse: true, wait: false})
    } else if (communityId) {
      const cursor = db.dbmethodResultsChronIdx.cursorRead(addPrefixToRangeOpts(communityId, {lt: opts?.lt, reverse: true}))
      cursor.prefixLength = communityId.length + 1
      return cursor
    }
  })

  const feedEntries = []
  const limit = Math.min(opts?.limit || 100, 100)
  const mergedCursor = mergeCursors(cursors)
  for await (let [db, entry] of mergedCursor) {
    if (db.dbType === 'ctzn.network/public-server-db') {
      // from your communities

      db = publicDbs.get(entry.value.database.userId)
      if (!db) continue
      const result = await db.dbmethodResults.get(entry.value.resultKey, {wait: false})
      if (!result) continue

      result.url = constructEntryUrl(db.url, 'ctzn.network/dbmethod-result', entry.value.resultKey)
      const callRes = await dbGet(result.value.call.dbUrl, {wait: false})
      if (!callRes) continue
      const call = callRes.entry
      call.url = result.value.call.dbUrl

      feedEntries.push({
        key: entry.key,
        caller: {dbUrl: callRes.db.url, userId: callRes.db.userId},
        call,
        result
      })
    } else {
      if (communityIds.includes(entry.value.database.userId)) {
        continue // skip, we'll get from the community's index
      }
      
      const call = entry
      call.url = constructEntryUrl(db.url, 'ctzn.network/dbmethod-call', entry.key)
      const resultUrl = constructEntryUrl(entry.value.database.dbUrl, 'ctzn.network/dbmethod-result', entry.url)
      const result = (await dbGet(resultUrl, {wait: false}))?.entry
      if (!result) continue
      result.url = resultUrl
      feedEntries.push({
        key: entry.key,
        caller: {dbUrl: db.url, userId: db.userId},
        call,
        result
      })
    }
    if (feedEntries.length >= limit) {
      break
    }
  }

  return feedEntries
}

async function* mergeCursors (cursors) {
  let cursorResults = []
  
  while (true) {
    let bestI = -1
    for (let i = 0; i < cursors.length; i++) {
      if (!cursors[i]) continue
      if (!cursorResults[i]?.length) {
        cursorResults[i] = await cursors[i].next(10)
        if (cursorResults[i]?.length && cursors[i].prefixLength) {
          for (let res of cursorResults[i]) {
            res.key = res.key.slice(cursors[i].prefixLength)
          }
        }
      }
      if (cursorResults[i]?.length) {
        if (bestI === -1) {
          bestI = i
        } else {
          if (cursorResults[i][0].key.localeCompare(cursorResults[bestI][0].key) === 1) {
            bestI = i
          }
        }
      }
    }

    if (bestI === -1) return // out of results
    yield [cursors[bestI].db, cursorResults[bestI].shift()]
  }
}