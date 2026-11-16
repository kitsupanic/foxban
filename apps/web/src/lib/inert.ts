const owners = new WeakMap<HTMLElement, { count: number; prior: boolean }>();

/** Keep shared backgrounds inert until their last modal closes. */
export function inertElements(elements: HTMLElement[]): () => void {
  for (const element of elements) {
    const state = owners.get(element) ?? { count: 0, prior: element.inert };
    state.count++;
    owners.set(element, state);
    element.inert = true;
  }
  return () => {
    for (const element of elements) {
      const state = owners.get(element)!;
      if (--state.count === 0) {
        element.inert = state.prior;
        owners.delete(element);
      }
    }
  };
}
