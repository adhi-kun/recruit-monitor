FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 4000

CMD ["sh", "-c", "ulimit -n 65536 && exec node --import tsx/esm src/server.ts"]
