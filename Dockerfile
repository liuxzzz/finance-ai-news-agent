FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY db ./db
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && chmod +x scripts/run-daily.sh

CMD ["node", "apps/cli/dist/index.js", "run-live", "--edition", "daily"]
