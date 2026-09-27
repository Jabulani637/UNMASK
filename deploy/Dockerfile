# The image that runs Unmask: the API, with the built site inside it.
#
#   docker build -f deploy/Dockerfile .
#
# The build context is the **project root**, not api\ — because config.js resolves
# WEB_DIST against the folder above the API, so the layout inside the image has to be
# the layout on the laptop (`api/` and `web/dist/` side by side) or the process would
# start and then serve nothing. That single fact is why this file is one stage deep
# rather than two services.
#
# The site is compiled here and copied in as static files. There is no second web
# server, no Nginx serving a root, no `nginx.conf` to keep in step with a CSP the API
# already sets: one origin means one set of headers, one cookie, one thing to update.

# ---- stage 1: build the site -------------------------------------------------
FROM node:24-alpine AS web

WORKDIR /src

# Lockfiles first, so a dependency that has not changed reuses this layer.
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
# `npm run build` is vite followed by scripts/no-foreign-origins.js, which fails the
# build if any third-party origin survived into the output. A build that reaches the
# end of this stage has therefore already been checked for calling home.
RUN npm run build

# ---- stage 2: the API, which is the only thing that runs ---------------------
FROM node:24-alpine

WORKDIR /srv/unmask

ENV NODE_ENV=production \
    PORT=4100

COPY api/package.json api/package-lock.json ./api/
RUN npm --prefix /srv/unmask/api ci --omit=dev

COPY api/ ./api/
COPY --from=web /src/dist ./web/dist

# Photos are personal data and they are in the container's filesystem by default,
# which is deleted with the container. Mount a volume here (the production compose
# file does) or every profile picture is lost on the next deploy.
VOLUME /srv/unmask/api/storage

EXPOSE 4100

# Readiness, not liveness: /api/health answers 503 while the database is still
# connecting, which is exactly the window a restart should wait out rather than kill.
# It reports booleans only — no secret, no URL, no path.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4100/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# init:true in the compose file is what delivers SIGTERM to node rather than to a
# shell; src/index.js answers it by closing the socket and the server, with a 4-second
# grace, so an open chat does not lose the message being typed.
WORKDIR /srv/unmask/api
CMD ["node", "src/index.js"]
