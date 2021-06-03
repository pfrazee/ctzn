import lexint from 'lexicographic-integer-encoding'
import { getDb, privateDbs, publicServerDb, getAllLoadedMemberDbs } from './index.js'
import { constructEntryUrl, parseEntryUrl } from '../lib/strings.js'
import { getPost } from './getters.js'
import { fetchAuthor, fetchReactions, fetchReposts, fetchReplyCount } from './util.js'
import * as errors from '../lib/errors.js'
import * as cache from '../lib/cache.js'
import { debugLog } from '../lib/debug-log.js'

const lexintEncoder = lexint('hex')

export async function listGlobalPostsFeed (opts, auth) {
  opts = opts && typeof opts === 'object' ? opts : {}
  const limit = Math.min(opts?.limit || 100, 100)
  opts.lt = opts.lt && typeof opts.lt === 'string' ? opts.lt : lexintEncoder.encode(Date.now())

  let mutedDbKeys
  const privateDb = auth ? privateDbs.get(auth.username) : undefined
  if (privateDb) {
    let settingsRecord = await privateDb.settings.get('self')
    mutedDbKeys = new Set(settingsRecord?.value?.mutedDbKeys || [])
  }

  let sourceDbs
  if (opts.audience) {
    const idx = await publicServerDb.communitiesIdx.get(opts.audience)
    if (!idx?.value?.memberDbKeys?.length) return []
    sourceDbs = idx.value.memberDbKeys.map(key => getDb(key)).filter(Boolean)
  } else {
    sourceDbs = getAllLoadedMemberDbs()
  }

  const cursors = sourceDbs.map(db => {
    if (!db) return undefined
    if (mutedDbKeys?.has?.(db.dbKey)) return undefined
    return db.posts.cursorRead({lt: opts?.lt, reverse: true, wait: false})
  })

  const postEntries = []
  const authorsCache = {}
  const mergedCursor = mergeCursors(cursors)
  for await (let [db, entry] of mergedCursor) {
    let wasFetched = false
    if (entry.value.source?.dbUrl) {
      let urlp = parseEntryUrl(entry.value.source.dbUrl)
      if (urlp.schemaId !== 'ctzn.network/post') continue
      if (mutedDbKeys?.has?.(urlp.dbKey)) continue
      entry = await getPost(getDb(urlp.dbKey), urlp.key)
      if (!entry) continue
      entry.repostedBy = await fetchAuthor(db.dbKey, authorsCache)
      wasFetched = true
    }
    if (opts?.audience && entry.value.audience !== opts.audience) {
      continue
    }
    if (!wasFetched) {
      entry.dbUrl = constructEntryUrl(db.url, 'ctzn.network/post', entry.key)
      entry.author = await fetchAuthor(db.dbKey, authorsCache)
      entry.reactions = (await fetchReactions(entry)).reactions
      entry.reposts = await fetchReposts(entry)
      entry.replyCount = await fetchReplyCount(entry)
    }
    postEntries.push(entry)
    if (postEntries.length >= limit) {
      break
    }
  }

  return postEntries
}

export async function listHomeFeed (opts, auth) {
  opts = opts && typeof opts === 'object' ? opts : {}
  const didSpecifyLt = !!opts.lt
  const limit = Math.min(opts?.limit || 100, 100)
  opts.lt = opts.lt && typeof opts.lt === 'string' ? opts.lt : lexintEncoder.encode(Date.now())

  if (!auth) throw new errors.SessionError()
  const publicDb = getDb(auth.username)
  if (!publicDb) throw new errors.NotFoundError('User database not found')

  let mutedDbKeys
  const privateDb = privateDbs.get(auth.username)
  if (privateDb) {
    let settingsRecord = await privateDb.settings.get('self')
    mutedDbKeys = new Set(settingsRecord?.value?.mutedDbKeys || [])
  }

  if (!didSpecifyLt && !opts.audience) {
    let cached = cache.getHomeFeed(auth.username, limit)
    if (cached) {
      debugLog.cacheHit('home-feed', auth.username)
      let cachedEntries = opts.limit ? cached.slice(0, limit) : cached
      for (let entry of cachedEntries) {
        entry.reactions = (await fetchReactions(entry)).reactions
        entry.reposts = await fetchReposts(entry)
        entry.replyCount = await fetchReplyCount(entry)
      }
      return cachedEntries
    }
  }

  const [profile, followEntries] = await Promise.all([
    publicDb.profile.get('self'),
    publicDb.follows.list()
  ])
  followEntries.unshift({value: {subject: auth}})
  const audience = opts.audience ? new Set([opts.audience]) : new Set(profile.value.communities || [])
  const sourceDbs = followEntries.map(f => getDb(f.value.subject.dbKey))
  
  const cursors = sourceDbs.map(db => {
    if (!db) return undefined
    if (mutedDbKeys?.has?.(db.dbKey)) return undefined
    return db.posts.cursorRead({lt: opts?.lt, reverse: true, wait: false})
  })

  const postEntries = []
  const authorsCache = {}
  const mergedCursor = mergeCursors(cursors)
  for await (let [db, entry] of mergedCursor) {
    let wasFetched = false
    if (entry.value.source?.dbUrl) {
      let urlp = parseEntryUrl(entry.value.source.dbUrl)
      if (mutedDbKeys?.has?.(urlp.dbKey)) continue
      if (urlp.schemaId !== 'ctzn.network/post') continue
      entry = await getPost(getDb(urlp.dbKey), urlp.key)
      if (!entry) continue
      entry.repostedBy = await fetchAuthor(db.dbKey, authorsCache)
      wasFetched = true
    }
    if (opts?.audience && !entry.value.audience) {
      continue
    }
    if (entry.value.audience && !audience.has(entry.value.audience)) {
      continue
    }
    if (!wasFetched) {
      entry.dbUrl = constructEntryUrl(db.url, 'ctzn.network/post', entry.key)
      entry.author = await fetchAuthor(db.dbKey, authorsCache)
      entry.reactions = (await fetchReactions(entry)).reactions
      entry.reposts = await fetchReposts(entry)
      entry.replyCount = await fetchReplyCount(entry)
    }
    postEntries.push(entry)
    if (postEntries.length >= limit) {
      break
    }
  }

  if (!didSpecifyLt && !opts.audience) {
    cache.setHomeFeed(auth.username, postEntries, limit, 60e3)
  }

  return postEntries
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