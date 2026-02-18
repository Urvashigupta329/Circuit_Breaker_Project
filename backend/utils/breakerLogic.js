const CircuitBreaker = require('../models/CircuitBreaker');
const Failure = require('../models/Failure');

/**
 * Circuit Breaker Logic Module
 * 
 * This module contains the core logic for the circuit breaker pattern:
 * 
 * STATES:
 * - CLOSED: Normal operation. Requests flow through. Failures are counted.
 * - OPEN: Circuit is tripped. All requests are immediately rejected (fail-fast).
 * - HALF_OPEN: Recovery testing. Limited requests are allowed to test if the
 *              downstream service has recovered.
 * 
 * WHY FAILURE RATE > RAW COUNT?
 * - Raw count: 5 failures out of 5 requests = 100% failure (critical!)
 * - Raw count: 5 failures out of 10000 requests = 0.05% failure (acceptable)
 * - Failure rate provides context and prevents false positives during low traffic
 * 
 * The circuit trips when BOTH conditions are met:
 * 1. Failure count >= threshold (prevents tripping on 1-2 random errors)
 * 2. Failure rate >= failureRateThreshold (provides statistical significance)
 */

// In-memory tracking for HALF_OPEN state (per-service)
const halfOpenState = new Map();

/**
 * Get or initialize HALF_OPEN tracking state for a service
 */
function getHalfOpenState(serviceName = 'default') {
  if (!halfOpenState.has(serviceName)) {
    halfOpenState.set(serviceName, {
      requestCount: 0,
      successCount: 0,
      failureCount: 0
    });
  }
  return halfOpenState.get(serviceName);
}

/**
 * Reset HALF_OPEN tracking state for a service
 */
function resetHalfOpenState(serviceName = 'default') {
  halfOpenState.set(serviceName, {
    requestCount: 0,
    successCount: 0,
    failureCount: 0
  });
}

/**
 * Get the circuit breaker instance for a service
 * @param {string} serviceName - Name of the service (default: 'default')
 */
async function getBreaker(serviceName = 'default') {
  const cb = await CircuitBreaker.getInstance(serviceName);
  return cb;
}

/**
 * Check if the current measurement window has expired and reset if needed
 * This ensures we're measuring failure rate in a rolling time window
 */
async function checkAndResetWindow(cb) {
  if (cb.isWindowExpired()) {
    console.log(`[CircuitBreaker:${cb.serviceName}] Measurement window expired, resetting counters`);
    cb.resetWindow();
    await cb.save();
  }
}

/**
 * Record a failure and potentially trip the circuit
 * 
 * @param {Object} options - Failure details
 * @param {string} options.serviceName - Service identifier
 * @param {string} options.message - Error message
 * @param {string} options.errorType - Type of error (TIMEOUT, CONNECTION, HTTP_ERROR)
 * @param {string} options.errorCode - HTTP status or error code
 * @param {string} options.endpoint - Which endpoint failed
 * @param {number} options.responseTime - Time until failure in ms
 */
async function recordFailure(options = {}) {
  const serviceName = options.serviceName || 'default';
  const cb = await getBreaker(serviceName);
  
  // Check if measurement window needs reset
  await checkAndResetWindow(cb);
  
  // Update counters
  cb.failureCount += 1;
  cb.failedRequests += 1;
  cb.totalRequests += 1;
  cb.lastFailureTime = new Date();
  cb.version += 1;
  
  // Log failure to history for analytics
  try {
    await Failure.logFailure({
      serviceName,
      message: options.message || 'Downstream failure recorded',
      errorType: options.errorType || 'UNKNOWN',
      errorCode: options.errorCode,
      endpoint: options.endpoint,
      responseTime: options.responseTime,
      circuitState: cb.state
    });
  } catch (e) {
    console.error(`[CircuitBreaker:${serviceName}] Failed to log failure:`, e.message);
  }
  
  // Handle HALF_OPEN state - single failure returns to OPEN
  if (cb.state === 'HALF_OPEN') {
    const hoState = getHalfOpenState(serviceName);
    hoState.failureCount += 1;
    
    console.log(`[CircuitBreaker:${serviceName}] HALF_OPEN failure detected, returning to OPEN`);
    cb.state = 'OPEN';
    cb.openedAt = new Date();
    cb.lastTripReason = 'HALF_OPEN test request failed';
    resetHalfOpenState(serviceName);
    await cb.save();
    return cb;
  }
  
  // Check if we should trip the circuit (CLOSED -> OPEN)
  const failureRate = cb.getFailureRate();
  const shouldTrip = 
    cb.failureCount >= cb.threshold && 
    failureRate >= cb.failureRateThreshold;
  
  if (shouldTrip && cb.state === 'CLOSED') {
    cb.state = 'OPEN';
    cb.openedAt = new Date();
    cb.totalTrips += 1;
    cb.lastTripReason = `Failure threshold exceeded: ${cb.failureCount} failures, ${failureRate.toFixed(2)}% failure rate`;
    
    console.log(`[CircuitBreaker:${serviceName}] CIRCUIT OPENED - ${cb.lastTripReason}`);
  }
  
  await cb.save();
  return cb;
}

/**
 * Record a successful request
 * Resets failure count in CLOSED state, advances recovery in HALF_OPEN
 * 
 * @param {string} serviceName - Service identifier
 */
async function recordSuccess(serviceName = 'default') {
  const cb = await getBreaker(serviceName);
  
  // Check if measurement window needs reset
  await checkAndResetWindow(cb);
  
  // Update counters
  cb.totalRequests += 1;
  cb.lastSuccessTime = new Date();
  
  if (cb.state === 'HALF_OPEN') {
    // Track success in HALF_OPEN state
    const hoState = getHalfOpenState(serviceName);
    hoState.successCount += 1;
    cb.successCount = hoState.successCount;
    
    console.log(`[CircuitBreaker:${serviceName}] HALF_OPEN success ${hoState.successCount}/${cb.successThreshold}`);
    
    // Check if we have enough successes to close the circuit
    if (hoState.successCount >= cb.successThreshold) {
      cb.state = 'CLOSED';
      cb.failureCount = 0;
      cb.failedRequests = 0;
      cb.successCount = 0;
      cb.openedAt = null;
      cb.resetWindow();
      resetHalfOpenState(serviceName);
      
      console.log(`[CircuitBreaker:${serviceName}] CIRCUIT CLOSED - recovered successfully`);
    }
  } else if (cb.state === 'CLOSED') {
    // In CLOSED state, successful requests reduce failure impact
    // Don't reset completely - let the window naturally expire
    // This prevents a single success from masking ongoing issues
  }
  
  await cb.save();
  return cb;
}

/**
 * Determine if a request should be allowed through
 * This is the main entry point called by the middleware
 * 
 * @param {string} serviceName - Service identifier
 * @returns {Object} { allowed: boolean, state: string, reason?: string }
 */
async function allowRequest(serviceName = 'default') {
  const cb = await getBreaker(serviceName);
  
  // CLOSED: Always allow
  if (cb.state === 'CLOSED') {
    return { allowed: true, state: 'CLOSED' };
  }
  
  // OPEN: Check if timeout has elapsed
  if (cb.state === 'OPEN') {
    const openedAt = cb.openedAt ? cb.openedAt.getTime() : (cb.lastFailureTime ? cb.lastFailureTime.getTime() : 0);
    const elapsed = Date.now() - openedAt;
    
    if (elapsed >= cb.timeout) {
      // Transition to HALF_OPEN
      cb.state = 'HALF_OPEN';
      cb.successCount = 0;
      resetHalfOpenState(serviceName);
      await cb.save();
      
      console.log(`[CircuitBreaker:${serviceName}] Timeout elapsed, transitioning to HALF_OPEN`);
      
      // Allow this first request
      const hoState = getHalfOpenState(serviceName);
      hoState.requestCount = 1;
      return { allowed: true, state: 'HALF_OPEN' };
    }
    
    // Still within timeout, reject
    const remaining = Math.ceil((cb.timeout - elapsed) / 1000);
    return { 
      allowed: false, 
      state: 'OPEN',
      reason: `Circuit is OPEN. Retry in ${remaining}s`,
      retryAfter: remaining
    };
  }
  
  // HALF_OPEN: Allow limited requests
  if (cb.state === 'HALF_OPEN') {
    const hoState = getHalfOpenState(serviceName);
    
    if (hoState.requestCount < cb.halfOpenMaxRequests) {
      hoState.requestCount += 1;
      console.log(`[CircuitBreaker:${serviceName}] HALF_OPEN request ${hoState.requestCount}/${cb.halfOpenMaxRequests} allowed`);
      return { allowed: true, state: 'HALF_OPEN' };
    }
    
    // Too many concurrent HALF_OPEN requests, reject
    return { 
      allowed: false, 
      state: 'HALF_OPEN',
      reason: 'HALF_OPEN request limit reached, waiting for test results'
    };
  }
  
  // Fallback - shouldn't reach here
  return { allowed: true, state: cb.state };
}

/**
 * Perform a health check against the downstream service
 * Used during HALF_OPEN state to proactively test recovery
 * 
 * @param {string} serviceName - Service identifier
 * @param {Function} healthCheckFn - Async function that tests the downstream service
 * @returns {Object} Health check result
 */
async function performHealthCheck(serviceName = 'default', healthCheckFn) {
  const cb = await getBreaker(serviceName);
  
  try {
    const startTime = Date.now();
    await healthCheckFn();
    const responseTime = Date.now() - startTime;
    
    console.log(`[CircuitBreaker:${serviceName}] Health check PASSED (${responseTime}ms)`);
    
    // If we're in HALF_OPEN, record this as a success
    if (cb.state === 'HALF_OPEN') {
      await recordSuccess(serviceName);
    }
    
    return { 
      healthy: true, 
      responseTime,
      state: cb.state
    };
  } catch (error) {
    console.log(`[CircuitBreaker:${serviceName}] Health check FAILED: ${error.message}`);
    
    // If we're in HALF_OPEN, record this as a failure
    if (cb.state === 'HALF_OPEN') {
      await recordFailure({ 
        serviceName, 
        message: `Health check failed: ${error.message}`,
        errorType: 'HEALTH_CHECK'
      });
    }
    
    return { 
      healthy: false, 
      error: error.message,
      state: cb.state
    };
  }
}

/**
 * Get comprehensive status for the dashboard
 * 
 * @param {string} serviceName - Service identifier
 * @param {number} failureLimit - Max failures to return
 * @returns {Object} Complete status object
 */
async function getStatus(serviceName = 'default', failureLimit = 50) {
  const cb = await getBreaker(serviceName);
  const failures = await Failure.getRecent(serviceName, failureLimit);
  const failureStats = await Failure.getStats(serviceName, cb.windowSize);
  const hoState = getHalfOpenState(serviceName);
  
  return { 
    breaker: cb.toStatusObject(),
    halfOpenState: cb.state === 'HALF_OPEN' ? {
      requestCount: hoState.requestCount,
      successCount: hoState.successCount,
      failureCount: hoState.failureCount,
      maxRequests: cb.halfOpenMaxRequests
    } : null,
    failures,
    failureStats,
    serverTime: new Date().toISOString()
  };
}

/**
 * Manually reset the circuit breaker
 * Used by admin endpoints and Unix signal handlers
 * 
 * @param {string} serviceName - Service identifier
 */
async function resetBreaker(serviceName = 'default') {
  const cb = await getBreaker(serviceName);
  
  const previousState = cb.state;
  
  cb.state = 'CLOSED';
  cb.failureCount = 0;
  cb.failedRequests = 0;
  cb.successCount = 0;
  cb.lastFailureTime = null;
  cb.lastSuccessTime = null;
  cb.openedAt = null;
  cb.totalTrips = 0;
  cb.lastTripReason = null;
  cb.resetWindow();
  cb.version += 1;
  
  resetHalfOpenState(serviceName);
  
  await cb.save();
  
  // Clear failure history for this service so dashboard shows clean state
  try {
    await Failure.deleteMany({ serviceName });
    console.log(`[CircuitBreaker:${serviceName}] Failure history cleared`);
  } catch (e) {
    console.error(`[CircuitBreaker:${serviceName}] Failed to clear failure history:`, e.message);
  }
  
  console.log(`[CircuitBreaker:${serviceName}] MANUAL RESET - ${previousState} -> CLOSED`);
  
  return cb;
}

/**
 * Update the failure threshold
 * Used by shell scripts for SLA-based tuning
 * 
 * @param {string} serviceName - Service identifier
 * @param {number} threshold - New failure count threshold
 */
async function updateThreshold(serviceName = 'default', threshold) {
  // Handle legacy call signature: updateThreshold(threshold)
  if (typeof serviceName === 'number') {
    threshold = serviceName;
    serviceName = 'default';
  }
  
  const cb = await getBreaker(serviceName);
  cb.threshold = threshold;
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Threshold updated to ${threshold}`);
  
  return cb;
}

/**
 * Update the failure rate threshold
 * 
 * @param {string} serviceName - Service identifier
 * @param {number} rate - New failure rate threshold (0-100)
 */
async function updateFailureRateThreshold(serviceName = 'default', rate) {
  const cb = await getBreaker(serviceName);
  cb.failureRateThreshold = Math.min(100, Math.max(0, rate));
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Failure rate threshold updated to ${rate}%`);
  
  return cb;
}

/**
 * Update the timeout duration
 * 
 * @param {string} serviceName - Service identifier
 * @param {number} timeout - New timeout in milliseconds
 */
async function updateTimeout(serviceName = 'default', timeout) {
  const cb = await getBreaker(serviceName);
  cb.timeout = timeout;
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Timeout updated to ${timeout}ms`);
  
  return cb;
}

/**
 * Update multiple configuration values at once
 * 
 * @param {string} serviceName - Service identifier
 * @param {Object} config - Configuration values to update
 */
async function updateConfig(serviceName = 'default', config = {}) {
  const cb = await getBreaker(serviceName);
  
  const allowedFields = [
    'threshold', 'failureRateThreshold', 'timeout', 
    'windowSize', 'halfOpenMaxRequests', 'successThreshold'
  ];
  
  for (const field of allowedFields) {
    if (config[field] !== undefined) {
      cb[field] = config[field];
    }
  }
  
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Configuration updated:`, config);
  
  return cb;
}

module.exports = { 
  getBreaker, 
  recordFailure, 
  recordSuccess, 
  allowRequest, 
  resetBreaker, 
  updateThreshold,
  updateFailureRateThreshold,
  updateTimeout,
  updateConfig,
  getStatus,
  performHealthCheck
};
