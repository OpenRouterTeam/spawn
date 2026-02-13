# Alibaba Cloud

Alibaba Cloud ECS (Elastic Compute Service) instances via Alibaba Cloud CLI. [Alibaba Cloud](https://www.alibabacloud.com/)

## Prerequisites

The scripts will automatically install the Alibaba Cloud CLI (`aliyun`) if not present.

Get your Access Key credentials from: https://ram.console.aliyun.com/manage/ak

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/alibabacloud/claude.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/alibabacloud/codex.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/alibabacloud/gemini.sh)
```

## Non-Interactive Mode

```bash
ALIYUN_INSTANCE_NAME=dev-mk1 \
ALIYUN_ACCESS_KEY_ID=your-access-key-id \
ALIYUN_ACCESS_KEY_SECRET=your-access-key-secret \
ALIYUN_REGION=cn-hangzhou \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/alibabacloud/claude.sh)
```

## Environment Variables

- `ALIYUN_ACCESS_KEY_ID` - Alibaba Cloud Access Key ID
- `ALIYUN_ACCESS_KEY_SECRET` - Alibaba Cloud Access Key Secret
- `ALIYUN_REGION` - Region (default: `cn-hangzhou`)
- `ALIYUN_INSTANCE_NAME` - Instance name (default: prompted)
- `ALIYUN_INSTANCE_TYPE` - Instance type (default: `ecs.t5-lc1m2.small`)
- `ALIYUN_IMAGE_ID` - Image ID (default: Ubuntu 24.04)
- `OPENROUTER_API_KEY` - OpenRouter API key

## Regions

Common Alibaba Cloud regions:
- `cn-hangzhou` - China (Hangzhou)
- `cn-shanghai` - China (Shanghai)
- `cn-beijing` - China (Beijing)
- `cn-shenzhen` - China (Shenzhen)
- `ap-southeast-1` - Singapore
- `ap-southeast-5` - Jakarta
- `us-west-1` - US (Silicon Valley)
- `us-east-1` - US (Virginia)
- `eu-central-1` - Germany (Frankfurt)

Full list: https://www.alibabacloud.com/help/en/ecs/user-guide/regions-and-zones

## Instance Types

The default instance type is `ecs.t5-lc1m2.small` (1 vCPU, 2GB RAM, burstable).

Other affordable options:
- `ecs.t5-lc1m1.small` - 1 vCPU, 1GB RAM (cheaper)
- `ecs.t5-lc1m2.small` - 1 vCPU, 2GB RAM (default)
- `ecs.t5-lc2m4.large` - 2 vCPU, 4GB RAM (more power)

Full list: https://www.alibabacloud.com/help/en/ecs/user-guide/overview-of-instance-families

## Pricing

Pricing varies by region and instance type. As of 2026:
- Entry-level instances start at ~$3.50/month
- Pay-as-you-go billing available
- Reserved instances offer up to 79% discount

Check current pricing: https://www.alibabacloud.com/pricing

## Notes

- Credentials are saved to `~/.config/spawn/alibabacloud.json` after first use
- The Alibaba Cloud CLI is automatically installed if not present
- Instances are created with cloud-init for automated setup
- SSH keys are automatically registered with Alibaba Cloud
- A VPC and vSwitch are created if none exist in the region
- A security group with SSH access (port 22) is created automatically
