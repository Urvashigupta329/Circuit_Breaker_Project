const axios = require('axios');
const breakerLogic = require('../utils/breakerLogic');

/**
 * Payment Service - Simulates calls to an external payment processor
 * 
 * In a real system, this would make HTTP calls to services like:
 * - Stripe, PayPal, Square for payments
 * - Bank APIs for transfers
 * - Third-party verification services
 * 
 * The circuit breaker protects against:
 * 1. Network timeouts (slow responses)
 * 2. Service unavailability (503, 502 errors)
 * 3. Rate limiting (429 errors)
 * 4. Cascading failures
 */

const SERVICE_NAME = 'payment-service';

// Configuration from environment variables
const config = {
  // Simulated external service URL (for testing)
  externalServiceUrl: process.env.PAYMENT_SERVICE_URL || null,
  
  // Simulation settings for demo/testing
  failRate: parseFloat(process.env.FAIL_RATE) || 0.3,  // 30% failure rate
  minLatency: parseInt(process.env.MIN_LATENCY) || 50,  // Minimum response time in ms
  maxLatency: parseInt(process.env.MAX_LATENCY) || 200, // Maximum response time in ms
  timeoutRate: parseFloat(process.env.TIMEOUT_RATE) || 0.1, // 10% timeout rate
  timeout: parseInt(process.env.PAYMENT_TIMEOUT) || 5000 // Request timeout in ms
};

/**
 * Simulate network latency
 */
function simulateLatency() {
  const latency = config.minLatency + Math.random() * (config.maxLatency - config.minLatency);
  return new Promise(resolve => setTimeout(resolve, latency));
}

/**
 * Simulate various failure scenarios for testing
 * In production, failures would come from actual network/service issues
 */
function getSimulatedError() {
  const rand = Math.random();
  
  if (rand < config.timeoutRate) {
    return {
      type: 'TIMEOUT',
      code: 'ETIMEDOUT',
      message: 'Payment service request timed out'
    };
  }
  
  if (rand < config.timeoutRate + 0.3) {
    return {
      type: 'CONNECTION',
      code: 'ECONNREFUSED',
      message: 'Payment service connection refused'
    };
  }
  
  if (rand < config.timeoutRate + 0.5) {
    return {
      type: 'HTTP_ERROR',
      code: '503',
      message: 'Payment service unavailable'
    };
  }
  
  return {
    type: 'HTTP_ERROR',
    code: '500',
    message: 'Payment service internal error'
  };
}

/**
 * Process a payment - main entry point
 * 
 * @param {Object} payload - Payment details
 * @param {number} payload.amount - Payment amount
 * @param {string} payload.currency - Currency code (USD, EUR, etc.)
 * @param {string} payload.customerId - Customer identifier
 * @returns {Object} Payment result
 */
async function processPayment(payload) {
  const startTime = Date.now();
  
  try {
    let result;
    
    // If external service URL is configured, make real HTTP call
    if (config.externalServiceUrl) {
      result = await makeExternalCall(payload);
    } else {
      // Use simulation for demo/testing
      result = await simulatePayment(payload);
    }
    
    // Record success with the circuit breaker
    await breakerLogic.recordSuccess(SERVICE_NAME);
    
    return {
      ok: true,
      transactionId: result.transactionId,
      message: 'Payment processed successfully',
      amount: payload.amount || 1,
      processingTime: Date.now() - startTime
    };
    
  } catch (err) {
    const responseTime = Date.now() - startTime;
    
    // Record failure with detailed information for analytics
    await breakerLogic.recordFailure({
      serviceName: SERVICE_NAME,
      message: err.message,
      errorType: err.type || 'UNKNOWN',
      errorCode: err.code || err.statusCode || 'N/A',
      endpoint: '/payment',
      responseTime
    });
    
    // Re-throw with additional context
    const error = new Error(err.message);
    error.type = err.type || 'UNKNOWN';
    error.code = err.code;
    error.responseTime = responseTime;
    throw error;
  }
}

/**
 * Simulate payment processing for demo/testing
 * Introduces configurable failures and latency
 */
async function simulatePayment(payload) {
  // Simulate network latency
  await simulateLatency();
  
  // Check if this request should fail (based on configured fail rate)
  const shouldFail = Math.random() < config.failRate;
  
  if (shouldFail) {
    const error = getSimulatedError();
    const err = new Error(error.message);
    err.type = error.type;
    err.code = error.code;
    throw err;
  }
  
  // Success - return mock transaction
  return {
    transactionId: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    status: 'completed'
  };
}

/**
 * Make actual HTTP call to external payment service
 * Used when PAYMENT_SERVICE_URL is configured
 */
async function makeExternalCall(payload) {
  try {
    const response = await axios.post(config.externalServiceUrl, payload, {
      timeout: config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': `req_${Date.now()}`
      }
    });
    
    return response.data;
    
  } catch (error) {
    // Map axios errors to our error format
    const err = new Error(error.message);
    
    if (error.code === 'ECONNABORTED') {
      err.type = 'TIMEOUT';
      err.code = 'ETIMEDOUT';
    } else if (error.code === 'ECONNREFUSED') {
      err.type = 'CONNECTION';
      err.code = error.code;
    } else if (error.response) {
      err.type = 'HTTP_ERROR';
      err.code = error.response.status.toString();
      err.message = error.response.data?.message || `HTTP ${error.response.status}`;
    } else {
      err.type = 'NETWORK';
      err.code = error.code || 'UNKNOWN';
    }
    
    throw err;
  }
}

/**
 * Health check for the payment service
 * Used by circuit breaker during HALF_OPEN state
 */
async function healthCheck() {
  if (config.externalServiceUrl) {
    // Real health check against external service
    const healthUrl = config.externalServiceUrl.replace(/\/payment.*$/, '/health');
    const response = await axios.get(healthUrl, { timeout: 3000 });
    return response.status === 200;
  }
  
  // For simulation, return success unless fail rate is 100%
  return config.failRate < 1.0;
}

/**
 * Get current service configuration
 * Useful for debugging and dashboard
 */
function getConfig() {
  return {
    serviceName: SERVICE_NAME,
    externalServiceUrl: config.externalServiceUrl ? '[configured]' : null,
    simulationMode: !config.externalServiceUrl,
    failRate: config.failRate,
    minLatency: config.minLatency,
    maxLatency: config.maxLatency,
    timeoutRate: config.timeoutRate,
    timeout: config.timeout
  };
}

/**
 * Update simulation settings at runtime
 * Useful for testing different failure scenarios
 */
function setConfig(newConfig) {
  if (newConfig.failRate !== undefined) {
    config.failRate = Math.max(0, Math.min(1, newConfig.failRate));
  }
  if (newConfig.minLatency !== undefined) {
    config.minLatency = Math.max(0, newConfig.minLatency);
  }
  if (newConfig.maxLatency !== undefined) {
    config.maxLatency = Math.max(config.minLatency, newConfig.maxLatency);
  }
  if (newConfig.timeoutRate !== undefined) {
    config.timeoutRate = Math.max(0, Math.min(1, newConfig.timeoutRate));
  }
  return getConfig();
}

module.exports = { 
  processPayment, 
  healthCheck, 
  getConfig, 
  setConfig,
  SERVICE_NAME 
};
