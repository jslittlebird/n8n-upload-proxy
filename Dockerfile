FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY server.js ./

# Create upload directory
RUN mkdir -p /app/uploads

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
