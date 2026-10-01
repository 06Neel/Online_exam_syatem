# Python Adventure - one image runs the whole app: Express + Socket.IO API
# and the built client.
#
# Antideploy uses a Dockerfile at the repository root instead of inferring
# build/start commands, which matters here: `dist/` is excluded from uploads,
# so without this file the server can start with no client to serve and the
# browser gets a blank page.
FROM node:22-slim

WORKDIR /app

# Dependencies first so this layer is cached between deploys.
# npm ci installs devDependencies too - vite is needed for the build below.
COPY package.json package-lock.json ./
RUN npm ci

# Source, question bank and frontend; then build the client into dist/.
COPY . .
RUN npm run build

# After the build: production mode for the running server.
ENV NODE_ENV=production

# Run unprivileged, like the buildpack path would.
RUN useradd --create-home --uid 10001 app \
  && chown -R app:app /app
USER app

# The server reads process.env.PORT; 3001 is its default.
EXPOSE 3001

CMD ["node", "server/index.js"]
