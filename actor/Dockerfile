# No browser: this Actor reads Facebook over plain HTTP, logged out. The puppeteer-chrome base
# image it used to build on carried a full Chrome install for a browser nothing launches any more.
FROM apify/actor-node:22

# Copy just the manifests first so a source-only change reuses the cached install layer.
COPY --chown=myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser . ./
RUN node --check src/main.js && node --test test/*.test.js

CMD npm start --silent
