FROM node:24-bookworm-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY pipeline ./pipeline
COPY cloud ./cloud
RUN node --check cloud/main.mjs && node --test cloud/test/*.test.mjs
CMD ["node", "cloud/main.mjs"]
