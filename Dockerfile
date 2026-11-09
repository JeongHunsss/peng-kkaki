FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
ENV PORT=3000
EXPOSE 3000
# localhost는 컨테이너 안에서 IPv6(::1)로 풀릴 수 있어 127.0.0.1로 직접 확인
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
USER node
CMD ["node", "server/index.js"]
