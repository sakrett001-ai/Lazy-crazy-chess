FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /work/browser-lab
COPY --chown=pwuser:pwuser package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=pwuser:pwuser . .
RUN mkdir -p evidence && chown pwuser:pwuser evidence
USER pwuser
ENV CI=1 QA_RENDERER=software
CMD ["sh", "-c", "npm run record && npm run test:logic && npm test"]
