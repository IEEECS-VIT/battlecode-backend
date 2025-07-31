FROM node:22-alpine

RUN apk add --no-cache redis

WORKDIR /usr/src/app

COPY package*.json ./
COPY prisma ./prisma

RUN npm install
RUN npx prisma generate

COPY . .

EXPOSE 8000

# Use this instead of migrate deploy
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]