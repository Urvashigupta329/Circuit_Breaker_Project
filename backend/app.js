/**
 * Circuit Breaker Pattern - Main Application Entry Point
 * 
 * This is a production-grade implementation of the Circuit Breaker pattern
 * using Node.js, Express, and MongoDB.
 * 
 * Architecture Overview:
 * ┌─────────────┐    ┌─────────────────┐    ┌─────────────────┐
 * │   Client    │───▶│ Circuit Breaker │───▶│  Downstream     │
 * │  (Frontend) │    │   Middleware    │    │    Service      │
 * └─────────────┘    └─────────────────┘    └─────────────────┘
 *                           │
 *                           ▼
 *                    ┌─────────────────┐
 *                    │    MongoDB      │
 *                    │  (State Store)  │
 *                    └─────────────────┘
 */

require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const breakerLogic = require('./utils/breakerLogic');
const circuitBreakerMiddleware = require('./middleware/circuitBreaker');
const paymentService = require('./services/paymentService');

// Initialize database connection
connectDB();

const app = express();
app.use(express.json());

// ============================================================================
// CORS Configuration
// In production, restrict this to your actual frontend domain
// ============================================================================
app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : ['*'];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'X-Circuit-State, X-Circuit-Service, Retry-After');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Prevent browsers from caching API responses (ensures fresh data on every fetch)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// ============================================================================
// Health Check Endpoints (excluded from circuit breaker)
// These endpoints are used for:
// 1. Load balancer health checks
// 2. Kubernetes liveness/readiness probes
// 3. Circuit breaker HALF_OPEN state recovery testing
// ============================================================================

/**
 * Basic health check - always returns 200 if server is running
 * Used by load balancers and container orchestrators
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * Detailed health check - includes dependency status
 * Used for comprehensive health monitoring
 */
app.get('/health/detailed', async (req, res) => {
  try {
    const status = await breakerLogic.getStatus();
    const mongooseState = require('mongoose').connection.readyState;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      dependencies: {
        mongodb: {
          connected: mongooseState === 1,
          state: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongooseState]
        },
        circuitBreaker: {
          state: status.breaker.state,
          failureRate: status.breaker.failureRate
        }
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

/**
 * Downstream service health check
 * Used during HALF_OPEN state to test if the downstream service has recovered
 * This prevents sending real traffic to a potentially still-failing service
 */
app.get('/health/downstream', async (req, res) => {
  try {
    const healthy = await paymentService.healthCheck();
    res.json({ 
      healthy,
      service: 'payment-service',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ 
      healthy: false,
      service: 'payment-service',
      error: error.message
    });
  }
});

// ============================================================================
// Circuit Breaker Middleware
// Protects all routes below this point
// Admin routes are excluded to allow monitoring even when circuit is open
// ============================================================================
app.use(circuitBreakerMiddleware({
  serviceName: paymentService.SERVICE_NAME,
  excludePaths: ['/admin', '/health', '/metrics'],
  onOpen: ({ serviceName, reason }) => {
    console.log(`[ALERT] Circuit breaker OPENED for ${serviceName}: ${reason}`);
    // In production, send alerts to monitoring systems (PagerDuty, Slack, etc.)
  },
  onClose: ({ serviceName }) => {
    console.log(`[INFO] Circuit breaker CLOSED for ${serviceName} - service recovered`);
  }
}));

// ============================================================================
// Protected Business Endpoints
// These routes are protected by the circuit breaker middleware
// ============================================================================

/**
 * Payment endpoint - simulates processing a payment
 * Protected by circuit breaker to prevent cascading failures
 */
app.post('/payment', async (req, res) => {
  try {
    const result = await paymentService.processPayment(req.body);
    res.json(result);
  } catch (err) {
    res.status(502).json({ 
      error: err.message,
      type: err.type || 'UNKNOWN',
      code: err.code,
      responseTime: err.responseTime
    });
  }
});

// ============================================================================
// Admin/Dashboard Endpoints
// These are NOT protected by circuit breaker (excluded paths)
// Used for monitoring, configuration, and manual intervention
// ============================================================================

/**
 * Get current circuit breaker status
 * Includes state, counters, failure history, and statistics
 */
app.get('/admin/status', async (req, res) => {
  try {
    const serviceName = req.query.service || paymentService.SERVICE_NAME;
    const limit = parseInt(req.query.limit) || 50;
    const status = await breakerLogic.getStatus(serviceName, limit);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status', details: error.message });
  }
});

/**
 * Update circuit breaker threshold (failure count)
 * Used by shell scripts for SLA-based tuning
 */
app.post('/admin/threshold', async (req, res) => {
  try {
    const { threshold, service = paymentService.SERVICE_NAME } = req.body;
    
    if (typeof threshold !== 'number' || threshold < 1) {
      return res.status(400).json({ error: 'threshold must be a positive number' });
    }
    
    const cb = await breakerLogic.updateThreshold(service, threshold);
    res.json({ 
      ok: true, 
      message: `Threshold updated to ${threshold}`,
      breaker: cb.toStatusObject()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update threshold', details: error.message });
  }
});

/**
 * Update circuit breaker configuration
 * Allows updating multiple settings at once
 */
app.post('/admin/config', async (req, res) => {
  try {
    const { service = paymentService.SERVICE_NAME, ...config } = req.body;
    const cb = await breakerLogic.updateConfig(service, config);
    res.json({ 
      ok: true, 
      message: 'Configuration updated',
      breaker: cb.toStatusObject()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config', details: error.message });
  }
});

/**
 * Manual circuit breaker reset
 * Forces the circuit back to CLOSED state
 * Use with caution - only when you're sure the downstream service is healthy
 */
app.post('/admin/reset', async (req, res) => {
  try {
    const serviceName = req.body.service || paymentService.SERVICE_NAME;
    await breakerLogic.resetBreaker(serviceName);
    res.json({ 
      ok: true, 
      message: `Circuit breaker for "${serviceName}" reset to CLOSED`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset breaker', details: error.message });
  }
});

/**
 * Trigger a health check and optionally advance HALF_OPEN recovery
 */
app.post('/admin/health-check', async (req, res) => {
  try {
    const serviceName = req.body.service || paymentService.SERVICE_NAME;
    const result = await breakerLogic.performHealthCheck(
      serviceName, 
      paymentService.healthCheck
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Health check failed', details: error.message });
  }
});

/**
 * Get/update payment service simulation configuration
 * Useful for testing different failure scenarios
 */
app.get('/admin/simulation', (req, res) => {
  res.json(paymentService.getConfig());
});

app.post('/admin/simulation', (req, res) => {
  const config = paymentService.setConfig(req.body);
  res.json({ ok: true, config });
});

// ============================================================================
// Metrics Endpoint (for Prometheus/Grafana integration)
// ============================================================================
app.get('/metrics', async (req, res) => {
  try {
    const status = await breakerLogic.getStatus();
    
    // Format metrics in Prometheus exposition format
    const metrics = [
      `# HELP circuit_breaker_state Current state of the circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)`,
      `# TYPE circuit_breaker_state gauge`,
      `circuit_breaker_state{service="${status.breaker.serviceName}"} ${['CLOSED', 'OPEN', 'HALF_OPEN'].indexOf(status.breaker.state)}`,
      ``,
      `# HELP circuit_breaker_failure_count Total failures in current window`,
      `# TYPE circuit_breaker_failure_count gauge`,
      `circuit_breaker_failure_count{service="${status.breaker.serviceName}"} ${status.breaker.failedRequests}`,
      ``,
      `# HELP circuit_breaker_request_total Total requests in current window`,
      `# TYPE circuit_breaker_request_total gauge`,
      `circuit_breaker_request_total{service="${status.breaker.serviceName}"} ${status.breaker.totalRequests}`,
      ``,
      `# HELP circuit_breaker_trips_total Total number of times circuit has opened`,
      `# TYPE circuit_breaker_trips_total counter`,
      `circuit_breaker_trips_total{service="${status.breaker.serviceName}"} ${status.breaker.totalTrips}`,
    ].join('\n');
    
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    res.status(500).send(`# Error: ${error.message}`);
  }
});

// ============================================================================
// Error Handling Middleware
// ============================================================================
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ============================================================================
// Unix Signal Handlers
// These allow operational control without restarting the server
// ============================================================================

/**
 * SIGUSR1: Reset circuit breaker manually
 * Usage: kill -SIGUSR1 <pid>
 * 
 * Useful for:
 * - Emergency recovery when you've fixed the downstream issue
 * - Testing circuit breaker behavior
 * - Automation scripts
 */
process.on('SIGUSR1', async () => {
  console.log('[SIGNAL] SIGUSR1 received — resetting circuit breaker');
  try {
    await breakerLogic.resetBreaker();
    console.log('[SIGNAL] Circuit breaker reset successful');
  } catch (e) {
    console.error('[SIGNAL] Failed to reset circuit breaker:', e.message);
  }
});

/**
 * SIGUSR2: Log current circuit breaker status
 * Usage: kill -SIGUSR2 <pid>
 * 
 * Useful for debugging without accessing the API
 */
process.on('SIGUSR2', async () => {
  console.log('[SIGNAL] SIGUSR2 received — logging circuit breaker status');
  try {
    const status = await breakerLogic.getStatus();
    console.log('[SIGNAL] Current status:', JSON.stringify(status.breaker, null, 2));
  } catch (e) {
    console.error('[SIGNAL] Failed to get status:', e.message);
  }
});

/**
 * Graceful shutdown on SIGTERM/SIGINT
 * Ensures clean disconnection from MongoDB
 */
async function gracefulShutdown(signal) {
  console.log(`[SIGNAL] ${signal} received — starting graceful shutdown`);
  
  try {
    const mongoose = require('mongoose');
    await mongoose.connection.close();
    console.log('[SHUTDOWN] MongoDB connection closed');
  } catch (e) {
    console.error('[SHUTDOWN] Error closing MongoDB:', e.message);
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================================
// Server Startup
// ============================================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          Circuit Breaker Service Started                     ║
╠══════════════════════════════════════════════════════════════╣
║  Port:       ${PORT.toString().padEnd(47)}║
║  Env:        ${(process.env.NODE_ENV || 'development').padEnd(47)}║
║  PID:        ${process.pid.toString().padEnd(47)}║
╠══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                  ║
║  • POST /payment           - Process payment                 ║
║  • GET  /health            - Health check                    ║
║  • GET  /admin/status      - Circuit breaker status          ║
║  • POST /admin/reset       - Reset circuit breaker           ║
║  • POST /admin/threshold   - Update failure threshold        ║
║  • POST /admin/config      - Update configuration            ║
║  • GET  /metrics           - Prometheus metrics              ║
╠══════════════════════════════════════════════════════════════╣
║  Signal Handlers:                                            ║
║  • SIGUSR1 - Reset circuit breaker                           ║
║  • SIGUSR2 - Log current status                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
