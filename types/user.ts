// types/user.ts

export type UserStatus = 'active' | 'banned' | 'suspended' | 'pending';

export interface UserRecord {
  uid: string;
  displayName?: string;
  email?: string;
  phone?: string;
  photoURL?: string;
  status: UserStatus;
  createdAt: number;
  lastLoginAt?: number;
  isAdmin?: boolean;
  banReason?: string;
  banAt?: number;
}

export interface UserSearchQuery {
  email?: string;
  phone?: string;
  uid?: string;
  limit?: number;
}
