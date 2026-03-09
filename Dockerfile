FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
# Install Firefox browser + system deps for Playwright
RUN bunx playwright install --with-deps firefox
COPY . .
CMD ["bun", "run", "src/index.ts"]
