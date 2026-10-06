import { mock, mockAllowed } from './mock';
import { payplus } from './payplus';
import { ProviderError, type Provider } from './types';

/** the provider of a terminal; the pretend one only where mockAllowed() */
export function providerOf(id: string): Provider {
  if (id === 'payplus') return payplus();
  if (id === 'mock' && mockAllowed()) return mock;
  throw new ProviderError(`no such payment provider here: ${id}`);
}
