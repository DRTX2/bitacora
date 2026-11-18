locals {
  alarm_actions = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}

# Errors mean webhooks are being retried by Hookrelay and, eventually, parked in its DLQ.
resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = local.functions
  alarm_name          = "${var.name}-${each.key}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.fn[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Many 401s on ingest: a misconfigured secret after rotation, or someone probing the endpoint.
resource "aws_cloudwatch_log_metric_filter" "rejected" {
  name           = "${var.name}-rejected-webhooks"
  log_group_name = aws_cloudwatch_log_group.fn["ingest"].name
  pattern        = "{ $.msg = \"rejected webhook\" }"
  metric_transformation {
    name      = "RejectedWebhooks"
    namespace = "Bitacora"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "rejected" {
  alarm_name          = "${var.name}-rejected-webhooks"
  namespace           = "Bitacora"
  metric_name         = "RejectedWebhooks"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}
