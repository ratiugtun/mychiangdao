FROM node:22-alpine

# Node 22 has built-in fetch, so no npm dependencies are needed
COPY check_availability.mjs /app/check_availability.mjs

ENTRYPOINT ["node", "/app/check_availability.mjs"]
