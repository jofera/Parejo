FROM node:22-slim

ENV NODE_ENV=production \
    TZ=Europe/Madrid \
    DATA_DIR=/data \
    PORT=3000

# Sin dependencias externas: no hay nada que instalar.
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# La base de datos vive en /data (volumen); el contenedor no corre como root.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/users').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
