import {
  GraphQLSchema,
  getIntrospectionQuery,
  buildClientSchema,
  validateSchema,
  IntrospectionQuery,
} from 'graphql'
import { NoSchemaError } from './util/NoSchemaError'
import { InvalidSchemaError } from './util/InvalidSchemaError'
import { ApolloLink, execute, toPromise } from 'apollo-link'
import { Map, set } from 'immutable'
import { makeOperation } from './util/makeOperation'
import { parseHeaders } from './util/parseHeaders'
import { LinkCreatorProps } from '../../state/sessions/fetchingSagas'
import * as LRU from 'lru-cache'

export interface TracingSchemaTuple {
  schema: GraphQLSchema
  tracingSupported: boolean
  isQueryPlanSupported: boolean
}

export interface SchemaFetchProps {
  endpoint: string
  headers?: string
}

export type LinkGetter = (session: LinkCreatorProps) => { link: ApolloLink }

/**
 * The SchemaFetcher class servers the purpose of providing the GraphQLSchema.
 * All sagas and every part of the UI is using this as a singleton to prevent
 * unnecessary calls to the server. We're not storing this information in Redux,
 * as it's a good practice to only store serializable data in Redux.
 * GraphQLSchema objects are serializable, but can easily exceed the localStorage
 * max. Another reason to keep this in a separate class is, that we have more
 * advanced requirements like caching.
 */
export class SchemaFetcher {
  /**
   * The `sessionCache` property is used for UI components, that need fast access to the current schema.
   * If the relevant information of the session didn't change (endpoint and headers),
   * the cached schema will be returned.
   */
  sessionCache: LRU.Cache<string, TracingSchemaTuple>
  /**
   * The `schemaInstanceCache` property is used to prevent unnecessary buildClientSchema calls.
   * It's tested by stringifying the introspection result, which is orders of magnitude
   * faster than rebuilding the schema.
   */
  schemaInstanceCache: LRU.Cache<string, GraphQLSchema>
  /**
   * The `linkGetter` property is a callback that provides an ApolloLink instance.
   * This can be overriden by the user.
   */
  linkGetter: LinkGetter
  /**
   * In order to prevent duplicate fetching of the same schema, we keep track
   * of all subsequent calls to `.fetch` with the `fetching` property.
   */
  fetching: Map<string, Promise<any>>
  /**
   * Other parts of the application can subscribe to change of a schema for a
   * particular session. These subscribers are being kept track of in the
   * `subscriptions` property
   */
  subscriptions: Map<string, (schema: GraphQLSchema) => void> = Map()
  constructor(linkGetter: LinkGetter) {
    this.sessionCache = new LRU<string, TracingSchemaTuple>({ max: 10 })
    this.schemaInstanceCache = new LRU({ max: 10 })
    this.fetching = Map()
    this.linkGetter = linkGetter
  }
  async fetch(session: SchemaFetchProps) {
    const hash = this.hash(session)
    const cachedSchema = this.sessionCache.get(hash)
    if (cachedSchema) {
      return cachedSchema
    }
    const fetching = this.fetching.get(hash)
    if (fetching) {
      return fetching
    }
    const promise = this.fetchSchema(session)
    this.fetching = this.fetching.set(hash, promise)
    return promise
  }
  subscribe(session: SchemaFetchProps, cb: (schema: GraphQLSchema) => void) {
    const hash = this.hash(session)
    this.subscriptions = this.subscriptions.set(hash, cb)
  }
  refetch(session: SchemaFetchProps) {
    return this.fetchSchema(session)
  }
  hash(session: SchemaFetchProps) {
    return `${session.endpoint}~${session.headers || ''}`
  }
  private getSchema(data: IntrospectionQuery) {
    const schemaString = JSON.stringify(data)
    const cachedSchema = this.schemaInstanceCache.get(schemaString)
    if (cachedSchema) {
      return cachedSchema
    }

    const schema = buildClientSchema(data)

    const validationErrors = validateSchema(schema)
    if (validationErrors && validationErrors.length > 0) {
      throw new InvalidSchemaError(validationErrors)
    }
    this.schemaInstanceCache.set(schemaString, schema)

    return schema
  }
  private async fetchSchema(
    session: SchemaFetchProps,
  ): Promise<{ schema: GraphQLSchema; tracingSupported: boolean } | null> {
    const hash = this.hash(session)
    try {
      const { endpoint } = session
      const headers = {
        ...parseHeaders(session.headers),
        'X-Apollo-Tracing': '1',
        // Breaking the X- header pattern here since it's dated, and not
        // recommended: https://www.mnot.net/blog/2009/02/18/x-
        'Apollo-Query-Plan-Experimental': '1',
      }

      const options = set(session, 'headers', headers) as any

      const { link } = this.linkGetter(options)

      const operation = makeOperation({ query: getIntrospectionQuery() })

      const schemaData = await toPromise(execute(link, operation))
      if (
        schemaData &&
        ((schemaData.errors && schemaData.errors.length > 0) ||
          !schemaData.data)
      ) {
        throw new Error(JSON.stringify(schemaData, null, 2))
      }

      if (!schemaData) {
        throw new NoSchemaError(endpoint)
      }

      const schema = this.getSchema(schemaData.data as IntrospectionQuery)

      const tracingSupported =
        (schemaData.extensions && Boolean(schemaData.extensions.tracing)) ||
        false
      const isQueryPlanSupported =
        (schemaData.extensions &&
          Boolean(schemaData.extensions.__queryPlanExperimental)) ||
        false
      const result: TracingSchemaTuple = {
        schema,
        tracingSupported,
        isQueryPlanSupported,
      }
      this.sessionCache.set(this.hash(session), result)
      const subscription = this.subscriptions.get(hash)
      if (subscription) {
        subscription(result.schema)
      }
      return result
    } finally {
      this.fetching.remove(hash)
    }
  }
}
