/**
 * Public edge. TLS terminates here and nowhere else; the API listens on plain
 * HTTP inside the VPC.
 *
 * In front of the API only. The workers have no listener, no target group and
 * no path in from the internet — they reach out to Recall, R2 and OpenAI and
 * nothing reaches back except through this load balancer.
 */

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS to the API"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Port 80 exists only to redirect. Recall's webhook delivery and every OAuth
# callback use https, so nothing legitimate arrives here — but a bare hostname
# typed into a browser does, and an unanswered :80 looks like an outage.
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To API tasks"
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  enable_deletion_protection = var.alb_deletion_protection
  drop_invalid_header_fields = true

  /**
   * 300s, not the 60s default. The collaborative notes endpoint holds a
   * WebSocket open through @fastify/websocket; at the default idle timeout the
   * ALB closes an editing session that pauses for a minute, and the client
   * reconnects into a Yjs resync every time somebody stops typing.
   */
  idle_timeout = 300

  dynamic "access_logs" {
    for_each = var.alb_access_logs_bucket == "" ? [] : [1]

    content {
      bucket  = var.alb_access_logs_bucket
      prefix  = local.name
      enabled = true
    }
  }

  tags = { Name = local.name }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  vpc_id      = aws_vpc.this.id
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"

  /**
   * /readyz, not /healthz — the distinction is the point.
   *
   * /healthz answers "is this process alive", which is what the container
   * health check asks and what a restart can fix. /readyz answers "should this
   * task receive traffic", which is false while the database is missing
   * migrations this image needs. Restarting would not fix that, so pointing
   * the load balancer at /healthz would put a task into rotation that is about
   * to 500 on every query against a table that does not exist yet.
   *
   * The deploy workflow runs migrations before updating the services, so in a
   * healthy deploy this never fires. It fires when that ordering breaks.
   */
  health_check {
    enabled             = true
    path                = "/readyz"
    protocol            = "HTTP"
    port                = "traffic-port"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight extraction request or a WebSocket close
  # handshake, short enough that a deploy is not measured in minutes.
  deregistration_delay = 60

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-api" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
