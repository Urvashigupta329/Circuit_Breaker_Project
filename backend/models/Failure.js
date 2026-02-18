const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Failure Schema - Stores detailed failure history for analytics and debugging
 * 
 * Why store failure history?
 * 1. Post-mortem analysis - understand what went wrong and when
 * 2. Pattern detection - identify recurring failure patterns
 * 3. SLA compliance reporting - track failure rates over time
 * 4. Alerting integration - trigger alerts based on failure patterns
 * 5. Recovery validation - verify that fixes actually resolved issues
 */
const FailureSchema = new Schema({
  // Which service/breaker this failure belongs to
  serviceName: { 
    type: String, 
    default: 'default',
    index: true  // Index for filtering by service
  },
  
  // Error details
  message: { type: String, required: true },
  errorCode: { type: String, default: null },        // HTTP status or error code
  errorType: { type: String, default: 'UNKNOWN' },   // TIMEOUT, CONNECTION, HTTP_ERROR, etc.
  
  // Request context (sanitized - no sensitive data!)
  endpoint: { type: String, default: null },         // Which endpoint failed
  method: { type: String, default: null },           // HTTP method
  
  // Timing information
  timestamp: { type: Date, default: Date.now, index: true },
  responseTime: { type: Number, default: null },     // How long before failure (ms)
  
  // Circuit state at time of failure
  circuitState: { 
    type: String, 
    enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], 
    default: 'CLOSED' 
  },
  
  // Additional metadata
  metadata: { type: Schema.Types.Mixed, default: {} }, // Flexible field for extra context
  
  // For TTL - auto-delete old failure records
  expiresAt: { 
    type: Date, 
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    index: { expireAfterSeconds: 0 }  // MongoDB TTL index
  }
}, { 
  timestamps: false,  // We use our own timestamp field
  collection: 'failures'
});

// Compound indexes for common queries
FailureSchema.index({ serviceName: 1, timestamp: -1 });  // Recent failures by service
FailureSchema.index({ errorType: 1, timestamp: -1 });    // Failures by type
FailureSchema.index({ serviceName: 1, errorType: 1 });   // Service + type combo

/**
 * Create a failure record with proper defaults
 */
FailureSchema.statics.logFailure = async function(data) {
  const failure = new this({
    serviceName: data.serviceName || 'default',
    message: data.message || 'Unknown error',
    errorCode: data.errorCode,
    errorType: data.errorType || 'UNKNOWN',
    endpoint: data.endpoint,
    method: data.method,
    responseTime: data.responseTime,
    circuitState: data.circuitState || 'CLOSED',
    metadata: data.metadata || {}
  });
  return failure.save();
};

/**
 * Get failure statistics for a time window
 */
FailureSchema.statics.getStats = async function(serviceName = 'default', windowMs = 3600000) {
  const since = new Date(Date.now() - windowMs);
  
  const stats = await this.aggregate([
    { 
      $match: { 
        serviceName, 
        timestamp: { $gte: since } 
      } 
    },
    {
      $group: {
        _id: '$errorType',
        count: { $sum: 1 },
        avgResponseTime: { $avg: '$responseTime' },
        lastOccurrence: { $max: '$timestamp' }
      }
    },
    { $sort: { count: -1 } }
  ]);
  
  const total = stats.reduce((sum, s) => sum + s.count, 0);
  
  return {
    serviceName,
    windowMs,
    totalFailures: total,
    byType: stats
  };
};

/**
 * Get recent failures for dashboard display
 */
FailureSchema.statics.getRecent = async function(serviceName = 'default', limit = 50) {
  return this.find({ serviceName })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

module.exports = mongoose.model('Failure', FailureSchema);
