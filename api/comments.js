import createMlts from 'monotonic-lexicographic-timestamp'
import { publicUserDbs, privateUserDbs, onDatabaseChange } from '../db/index.js'
import { constructEntryUrl } from '../lib/strings.js'
import * as errors from '../lib/errors.js'

const mlts = createMlts()

export function setup (wsServer) {
  wsServer.register('comments.create', async ([post], client) => {
    if (!client?.auth) throw new errors.SessionError()
    const publicUserDb = publicUserDbs.get(client.auth.userId)
    if (!publicUserDb) throw new errors.NotFoundError('User database not found')

    const key = mlts()
    post.createdAt = (new Date()).toISOString()
    await publicUserDb.comments.put(key, post)

    const indexingDbs = [privateUserDbs.get(client.auth.userId)]
    if (post.community && publicUserDbs.has(post.community.userId)) {
      indexingDbs.push(publicUserDbs.get(post.community.userId))
    }
    await onDatabaseChange(publicUserDb, indexingDbs)
    
    const url = constructEntryUrl(publicUserDb.url, 'ctzn.network/comment', key)
    return {key, url}
  })

  wsServer.register('comments.edit', async ([key, post], client) => {
    if (!client?.auth) throw new errors.SessionError()
    const publicUserDb = publicUserDbs.get(client.auth.userId)
    if (!publicUserDb) throw new errors.NotFoundError('User database not found')

    const postEntry = await publicUserDb.comments.get(key)
    if (!postEntry) {
      throw new Error('Post not found')
    }

    postEntry.value.text = ('text' in post) ? post.text : postEntry.value.text
    await publicUserDb.comments.put(key, postEntry.value)
    await onDatabaseChange(publicUserDb, [privateUserDbs.get(client.auth.userId)])

    const url = constructEntryUrl(publicUserDb.url, 'ctzn.network/comment', postEntry.key)
    return {key, url}
  })

  wsServer.register('comments.del', async ([key], client) => {
    if (!client?.auth) throw new errors.SessionError()
    const publicUserDb = publicUserDbs.get(client.auth.userId)
    if (!publicUserDb) throw new errors.NotFoundError('User database not found')
    
    await publicUserDb.comments.del(key)
    await onDatabaseChange(publicUserDb, [privateUserDbs.get(client.auth.userId)])
  })
}