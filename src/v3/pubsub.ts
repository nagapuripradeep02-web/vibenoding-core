/**
 * V3.0 In-Memory Pub/Sub
 * EventEmitter-based pub/sub for real-time workflow state updates
 */

import { EventEmitter } from 'events';
import type { WorkflowState } from './types';

// Increase max listeners for high-traffic scenarios
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// Type for state callback
type StateCallback = (state: WorkflowState) => void;

/**
 * Generate a pub/sub key for a workflow
 */
export function getWorkflowKey(connectionId: string, workflowId: string): string {
  return `${connectionId}:${workflowId}`;
}

/**
 * Publish workflow state to all subscribers
 */
export function publishWorkflowState(key: string, state: WorkflowState): void {
  emitter.emit(key, state);
  console.log(`[PubSub] Published state for ${key}, ${emitter.listenerCount(key)} subscribers`);
}

/**
 * Subscribe to workflow state updates
 * Returns unsubscribe function
 */
export function subscribeWorkflowState(key: string, callback: StateCallback): () => void {
  emitter.on(key, callback);
  console.log(`[PubSub] New subscriber for ${key}, total: ${emitter.listenerCount(key)}`);
  
  // Return unsubscribe function
  return () => {
    emitter.off(key, callback);
    console.log(`[PubSub] Unsubscribed from ${key}, remaining: ${emitter.listenerCount(key)}`);
  };
}

/**
 * Unsubscribe a specific callback from workflow state updates
 */
export function unsubscribeWorkflowState(key: string, callback: StateCallback): void {
  emitter.off(key, callback);
}

/**
 * Get count of subscribers for a workflow
 */
export function getSubscriberCount(key: string): number {
  return emitter.listenerCount(key);
}

/**
 * Remove all subscribers for a workflow (cleanup)
 */
export function removeAllSubscribers(key: string): void {
  emitter.removeAllListeners(key);
}

/**
 * Check if there are any subscribers for a workflow
 */
export function hasSubscribers(key: string): boolean {
  return emitter.listenerCount(key) > 0;
}



