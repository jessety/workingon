# Build Stage

FROM node:24-alpine AS builder

# cd into working directory
WORKDIR /usr/src/app

# Copy over the the package, lock file, and local .npmrc
COPY package*.json ./
COPY /*.npmrc ./

# Use docker secrets to install all dependencies
RUN --mount=type=secret,id=npm,target=/root/.npmrc npm ci --ignore-scripts

# Copy over everything else and build the project
COPY . .
RUN npm run build

# Remove build info from the compiled output
RUN rm build/.tsbuildinfo

# Remove all development dependencies and install only dependencies required to run in production
RUN rm -rf node_modules
RUN --mount=type=secret,id=npm,target=/root/.npmrc npm ci --omit=dev --ignore-scripts

# Production stage

FROM node:24-alpine AS base

# cd into working directory
WORKDIR /usr/src/app

# Chown the directory
RUN chown node:node .

# Switch to service user
USER node

# IMPORTANT. The following code ONLY copies over:
#  1. The `build` folder, the compiled version of `src`
#  2. The `node_modules` with production dependencies only
#  3. All `.env` files in the root of the project
# This is to keep our images nice and clean.
# If this service requires additional code or configuration, make sure to add it here

# Copy over package.json
COPY package.json ./

# Copy the build from the first stage
COPY --from=builder /usr/src/app/build/ build/

# Copy the production node_modules from the first stage
COPY --from=builder /usr/src/app/node_modules/ node_modules/

# Copy over the defaults and type definitions env-smart applies at runtime.
# `.env` itself is deliberately NOT copied — baking secrets into the image is
# a bad idea. Pass them in at run time with `--env-file .env`.
COPY .env.defaults .env.types ./

# Inside the container the server must bind all interfaces for `-p` port publishing
# to reach it; outside Docker the default is loopback (see .env.defaults)
ENV HOST=0.0.0.0

# Expose the port
EXPOSE 8220

# Start the service, exposing the node process directly to Kubernetes
CMD [ "node", "--enable-source-maps", "build/index.js" ]
