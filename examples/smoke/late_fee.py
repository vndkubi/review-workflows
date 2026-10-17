from decimal import Decimal

GRACE_DAYS = 30


def late_fee(amount, days_late):
    """Late fee: 1% of the amount per day after a 30-day grace period, capped at 20% of the amount."""
    if days_late > GRACE_DAYS:
        fee = amount * 0.01 * (days_late - GRACE_DAYS)
    return min(fee, amount * 0.2)
