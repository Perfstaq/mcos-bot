# One image, two commands. The API and the workers are the same build:
#   node apps/api/dist/server.js   → HTTP (also serves the built SPA)
#   node apps/api/dist/worker.js   → BullMQ workers
# That is the whole deployment topology: one service + N worker replicas.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/render/package.json packages/render/
RUN npm ci

COPY apps/api/prisma apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

COPY . .
RUN npm run build

# Drop dev dependencies but keep the generated Prisma client.
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache dumb-init && addgroup -S mcos && adduser -S mcos -G mcos

COPY --from=build --chown=mcos:mcos /app/node_modules ./node_modules
COPY --from=build --chown=mcos:mcos /app/package.json ./package.json
COPY --from=build --chown=mcos:mcos /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=mcos:mcos /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=mcos:mcos /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=mcos:mcos /app/apps/web/dist ./apps/web/dist
# node_modules above already contains node_modules/@mcos/render, a symlink
# to this directory (npm workspaces) — without the directory itself present,
# that symlink dangles. apps/api's src doesn't import @mcos/render today,
# but plan.build (queue.ts: it runs on THIS lean worker, not worker-media)
# is obliged by ADR-8 to import @mcos/render/gates/g1a once Agent M writes
# it, and a dangling workspace symlink is exactly the kind of thing that
# only breaks in a deploy, with no obvious cause, months from now.
COPY --from=build --chown=mcos:mcos /app/packages/render/package.json ./packages/render/package.json
COPY --from=build --chown=mcos:mcos /app/packages/render/dist ./packages/render/dist

USER mcos
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
