FROM node:22-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN PGLITE_DIR=memory:// GROWTHOS_WORKER=off npm run build
# Build tools and the retired Circle SDKs never ship in the running image.
RUN npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
