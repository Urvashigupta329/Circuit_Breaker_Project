const breakerLogic = require('../utils/breakerLogic');

/**
 * Circuit Breaker Middleware for Express
 * 
 * This middleware intercepts requests BEFORE they reach your route handlers.
 * It implements the fail-fast pattern: when the circuit is OPEN, requests
 * are immediately rejected without attempting to call the downstream service.
 * 
 * Benefits:
 * 1. Protects downstream services from being overwhelmed
 * 2. Provides fast feedback to clients (no waiting for timeouts)
 * 3. Allows the system to recover gracefully
 * 4. Reduces resource consumption during outages
 * 
 * Usage:
 *   // Protect all routes
 *   app.use(circuitBreakerMiddleware());
 *   
 *   // Protect specific routes
 *   app.use('/api/payments', circuitBreakerMiddleware({ serviceName: 'payment-service' }));
 * 
 * @param {Object} options - Configuration options
 * @param {string} options.serviceName - Identifier for this circuit (default: 'default')
 * @param {string[]} options.excludePaths - Paths to exclude from circuit breaker (admin routes)
 * @param {Function} options.onOpen - Callback when circuit opens
 * @param {Function} options.onClose - Callback when circuit closes
 */
function circuitBreakerMiddleware(options = {}) {
  const {
    serviceName = 'default',
    excludePaths = ['/admin', '/health', '/metrics'],
    onOpen = null,
    onClose = null
  } = options;

  // Track state changes for callbacks
  let lastState = 'CLOSED';

  return async function circuitBreaker(req, res, next) {
    // Skip circuit breaker for excluded paths (admin, health checks, etc.)
    const isExcluded = excludePaths.some(path => req.path.startsWith(path));
    if (isExcluded) {
      return next();
    }

    try {
      const result = await breakerLogic.allowRequest(serviceName);
      
      // Trigger callbacks on state changes
      if (result.state !== lastState) {
        if (result.state === 'OPEN' && onOpen) {
          onOpen({ serviceName, reason: result.reason });
        } else if (result.state === 'CLOSED' && lastState !== 'CLOSED' && onClose) {
          onClose({ serviceName });
        }
        lastState = result.state;
      }

      if (!result.allowed) {
        // Circuit is OPEN - fail fast
        res.set('X-Circuit-State', result.state);
        res.set('X-Circuit-Service', serviceName);
        
        if (result.retryAfter) {
          res.set('Retry-After', result.retryAfter);
        }
        
        return res.status(503).json({ 
          error: 'Service temporarily unavailable',
          message: result.reason || 'Circuit breaker is open',
          state: result.state,
          serviceName,
          retryAfter: result.retryAfter || null
        });
      }

      // Store circuit info in request for downstream use
      req.circuitBreaker = {
        serviceName,
        state: result.state
      };

      // Add custom headers for observability
      res.set('X-Circuit-State', result.state);
      res.set('X-Circuit-Service', serviceName);

      next();
    } catch (err) {
      // Middleware error - log but allow request through
      // Better to fail open than block everything due to a bug
      console.error(`[CircuitBreaker:${serviceName}] Middleware error:`, err.message);
      req.circuitBreaker = { serviceName, state: 'UNKNOWN', error: err.message };
      next();
    }
  };
}

/**
 * Factory to create service-specific middleware
 * Useful when you have multiple downstream services with different breakers
 * 
 * @param {string} serviceName - Name of the downstream service
 * @param {Object} options - Additional options
 */
circuitBreakerMiddleware.forService = function(serviceName, options = {}) {
  return circuitBreakerMiddleware({ ...options, serviceName });
};

/**
 * Wrap an async function with circuit breaker logic
 * Useful for wrapping service calls rather than using middleware
 * 
 * @param {string} serviceName - Service identifier
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Additional options
 */
circuitBreakerMiddleware.wrap = function(serviceName, fn, options = {}) {
  return async function wrappedFunction(...args) {
    const result = await breakerLogic.allowRequest(serviceName);
    
    if (!result.allowed) {
      const error = new Error(`Circuit breaker open for ${serviceName}`);
      error.code = 'CIRCUIT_OPEN';
      error.state = result.state;
      error.retryAfter = result.retryAfter;
      throw error;
    }
    
    const startTime = Date.now();
    
    try {
      const response = await fn(...args);
      await breakerLogic.recordSuccess(serviceName);
      return response;
    } catch (error) {
      await breakerLogic.recordFailure({
        serviceName,
        message: error.message,
        errorType: error.code || 'UNKNOWN',
        responseTime: Date.now() - startTime
      });
      throw error;
    }
  };
};

module.exports = circuitBreakerMiddleware;
