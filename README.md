> **NOTE:** This is a fork of `graphql-playground` which is meant to be used by Apollo Server. It is not intended to be used directly. Those looking to use GraphQL Playground directly can refer to [the upstream repository](https://github.com/apollographql/graphql-playground) for usage instructions.

> **SECURITY WARNING:** See README in the upstream repository.

## Build process

```
export NODE_OPTIONS=--openssl-legacy-provider

cd graphql-playground
npm i -f
```

If you need to rebuild playground frontend (React application)

```
cd packages/graphql-playground-react
npm i
npm run build

# Then copy built artefacts to dapp-gateway or use another webserver to server these files
# cp  build/static/js ~/dapp-gateway/static/
```

If you need to rebuild playground HTML page generation

```
cd packages/graphql-playground-html
npm i
npm run build
```

Update content of `node_modules/@apollographql/graphql-playground-html` directory, see dependency graph:

```
apollo-server-express---> apollo-server-core---> @apollographql/graphql-playground-html
                     \__________________________/
```
