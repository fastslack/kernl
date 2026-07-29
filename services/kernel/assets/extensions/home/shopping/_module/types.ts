export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Store {
  id: string;
  name: string;
  location: string;
  notes: string;
  is_supplier: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category_id: string | null;
  tags: string; // comma-separated
  unit: string;
  current_stock: number;
  min_stock: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ShoppingList {
  id: string;
  name: string;
  status: "active" | "completed" | "archived";
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ShoppingListItem {
  id: string;
  list_id: string;
  product_id: string | null;
  name: string;
  quantity: number;
  unit: string;
  checked: number; // 0 | 1
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Purchase {
  id: string;
  product_id: string;
  store_id: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  currency: string;
  purchased_at: string;
  notes: string;
  created_at: string;
}
