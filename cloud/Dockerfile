FROM node:24-bookworm-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY actor/src/contactTarget.js actor/src/contactValues.js actor/src/proofAddress.js ./actor/src/
COPY pipeline ./pipeline
COPY cloud ./cloud
COPY .actor/input_schema.json ./.actor/input_schema.json
RUN node --check cloud/main.mjs && node --test cloud/test/*.test.mjs
CMD ["node", "cloud/main.mjs"]
