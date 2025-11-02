export type SplitAmountOptions = {
  total: number;
  participantCount: number;
  roundingStep?: number | null;
};

function toCents(value: number) {
  return Math.round(value * 100);
}

function fromCents(value: number) {
  return Math.round(value) / 100;
}

/**
 * Split the total amount evenly across participants while optionally rounding up to the
 * specified step (in baht). Any rounding surplus is redistributed so the sum of shares
 * always matches the original total.
 */
export function splitAmount({ total, participantCount, roundingStep }: SplitAmountOptions): number[] {
  if (!Number.isFinite(total) || total <= 0 || participantCount <= 0) {
    return [];
  }

  const totalCents = toCents(total);
  const baseShare = Math.floor(totalCents / participantCount);
  const baseShares = Array.from({ length: participantCount }, () => baseShare);

  let remainder = totalCents - baseShare * participantCount;
  let index = 0;
  while (remainder > 0) {
    baseShares[index % participantCount] += 1;
    remainder -= 1;
    index += 1;
  }

  let shares = [...baseShares];

  const step = roundingStep && roundingStep > 0 ? Math.max(1, toCents(roundingStep)) : 0;

  if (step > 0) {
    shares = shares.map((value) => Math.ceil(value / step) * step);

    let surplus = shares.reduce((sum, value) => sum + value, 0) - totalCents;

    if (surplus > 0) {
      for (let i = shares.length - 1; i >= 0 && surplus > 0; i -= 1) {
        const minAllowed = Math.max(baseShares[i], step);

        while (shares[i] - step >= minAllowed && surplus >= step) {
          shares[i] -= step;
          surplus -= step;
        }

        if (surplus > 0) {
          const reduction = Math.min(surplus, shares[i] - baseShares[i]);
          if (reduction > 0) {
            shares[i] -= reduction;
            surplus -= reduction;
          }
        }
      }

      if (surplus > 0 && shares.length > 0) {
        const lastIndex = shares.length - 1;
        shares[lastIndex] = Math.max(0, shares[lastIndex] - surplus);
        surplus = 0;
      }
    }
  }

  const finalSum = shares.reduce((sum, value) => sum + value, 0);
  const difference = totalCents - finalSum;

  if (difference !== 0 && shares.length > 0) {
    const lastIndex = shares.length - 1;
    shares[lastIndex] = Math.max(0, shares[lastIndex] + difference);
  }

  return shares.map(fromCents);
}
