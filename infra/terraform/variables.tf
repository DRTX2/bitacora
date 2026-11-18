variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource."
  type        = string
  default     = "bitacora"
}

variable "api_token" {
  description = "Bearer token for the read and admin APIs."
  type        = string
  sensitive   = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "alarm_topic_arn" {
  description = "SNS topic for alarms (empty = alarms without notifications)."
  type        = string
  default     = ""
}
