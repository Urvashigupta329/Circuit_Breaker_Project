#!/usr/bin/env bash
#
# update-threshold.sh - Dynamically update circuit breaker thresholds based on SLA
#
# This script is designed to be called by:
# 1. CI/CD pipelines - adjust thresholds during deployments
# 2. Monitoring systems - automatic tuning based on current conditions
# 3. Cron jobs - scheduled SLA-based adjustments
# 4. Manual operator intervention
#
# WHY SLA-BASED TUNING?
# Different times/conditions may require different sensitivity:
# - During peak hours: More lenient (higher threshold) to avoid false positives
# - During maintenance: More aggressive (lower threshold) for quick detection
# - Based on SLA tier: Critical services need stricter monitoring
#
# Usage Examples:
#   ./update-threshold.sh localhost:3000 5        # Set threshold to 5 failures
#   ./update-threshold.sh localhost:3000 auto     # Auto-tune based on SLA
#   ./update-threshold.sh localhost:3000 status   # Get current status
#
# SLA Tiers (when using 'auto'):
#   CRITICAL: 99.99% uptime = very low threshold (2)
#   HIGH:     99.9% uptime  = low threshold (5)
#   MEDIUM:   99% uptime    = medium threshold (10)
#   LOW:      95% uptime    = high threshold (20)
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DEFAULT_HOST="localhost:3000"
SLA_TIER="${SLA_TIER:-MEDIUM}"

# SLA tier to threshold mapping
declare -A THRESHOLDS=(
  ["CRITICAL"]=2
  ["HIGH"]=5
  ["MEDIUM"]=10
  ["LOW"]=20
)

# SLA tier to failure rate mapping
declare -A FAILURE_RATES=(
  ["CRITICAL"]=20
  ["HIGH"]=30
  ["MEDIUM"]=50
  ["LOW"]=70
)

usage() {
  echo "Usage: $0 <host:port> <threshold|auto|status|reset|config>"
  echo ""
  echo "Commands:"
  echo "  <number>  - Set failure count threshold to specific value"
  echo "  auto      - Auto-tune based on SLA_TIER environment variable"
  echo "  status    - Get current circuit breaker status"
  echo "  reset     - Reset circuit breaker to CLOSED"
  echo "  config    - Update full configuration based on SLA tier"
  echo ""
  echo "Environment Variables:"
  echo "  SLA_TIER  - CRITICAL, HIGH, MEDIUM (default), or LOW"
  echo ""
  echo "Examples:"
  echo "  $0 localhost:3000 5"
  echo "  SLA_TIER=CRITICAL $0 localhost:3000 auto"
  echo "  $0 localhost:3000 status"
  exit 1
}

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check if curl is available
check_dependencies() {
  if ! command -v curl &> /dev/null; then
    log_error "curl is required but not installed"
    exit 1
  fi
  if ! command -v jq &> /dev/null; then
    log_warn "jq not installed - output will be raw JSON"
  fi
}

# Format JSON output if jq is available
format_json() {
  if command -v jq &> /dev/null; then
    jq '.'
  else
    cat
  fi
}

# Get current status
get_status() {
  local host="$1"
  log_info "Fetching circuit breaker status from $host"
  
  response=$(curl -s -w "\n%{http_code}" "http://$host/admin/status" 2>&1)
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$ d')
  
  if [ "$http_code" = "200" ]; then
    echo "$body" | format_json
  else
    log_error "Failed to get status (HTTP $http_code)"
    echo "$body"
    exit 1
  fi
}

# Update threshold
update_threshold() {
  local host="$1"
  local threshold="$2"
  
  log_info "Updating threshold to $threshold on $host"
  
  response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"threshold\":$threshold}" \
    "http://$host/admin/threshold" 2>&1)
  
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$ d')
  
  if [ "$http_code" = "200" ]; then
    log_info "Threshold updated successfully"
    echo "$body" | format_json
  else
    log_error "Failed to update threshold (HTTP $http_code)"
    echo "$body"
    exit 1
  fi
}

# Update full configuration based on SLA tier
update_config() {
  local host="$1"
  local tier="${2:-$SLA_TIER}"
  
  threshold=${THRESHOLDS[$tier]:-10}
  failure_rate=${FAILURE_RATES[$tier]:-50}
  
  log_info "Applying SLA tier '$tier' configuration"
  log_info "  Threshold: $threshold failures"
  log_info "  Failure Rate: $failure_rate%"
  
  response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"threshold\":$threshold,\"failureRateThreshold\":$failure_rate}" \
    "http://$host/admin/config" 2>&1)
  
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$ d')
  
  if [ "$http_code" = "200" ]; then
    log_info "Configuration updated successfully"
    echo "$body" | format_json
  else
    log_error "Failed to update configuration (HTTP $http_code)"
    echo "$body"
    exit 1
  fi
}

# Reset circuit breaker
reset_breaker() {
  local host="$1"
  
  log_info "Resetting circuit breaker on $host"
  
  response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{}" \
    "http://$host/admin/reset" 2>&1)
  
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$ d')
  
  if [ "$http_code" = "200" ]; then
    log_info "Circuit breaker reset successfully"
    echo "$body" | format_json
  else
    log_error "Failed to reset circuit breaker (HTTP $http_code)"
    echo "$body"
    exit 1
  fi
}

# Auto-tune based on SLA tier
auto_tune() {
  local host="$1"
  
  threshold=${THRESHOLDS[$SLA_TIER]:-10}
  
  log_info "Auto-tuning for SLA tier: $SLA_TIER"
  log_info "Setting threshold to: $threshold"
  
  update_config "$host" "$SLA_TIER"
}

# Main execution
main() {
  check_dependencies
  
  if [ $# -lt 2 ]; then
    usage
  fi
  
  HOST="$1"
  ACTION="$2"
  
  case "$ACTION" in
    status)
      get_status "$HOST"
      ;;
    reset)
      reset_breaker "$HOST"
      ;;
    auto)
      auto_tune "$HOST"
      ;;
    config)
      update_config "$HOST" "${3:-$SLA_TIER}"
      ;;
    [0-9]*)
      update_threshold "$HOST" "$ACTION"
      ;;
    *)
      log_error "Unknown action: $ACTION"
      usage
      ;;
  esac
}

main "$@"
