"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatPrice } from "@/lib/format";
import { availabilityOf } from "@/lib/inventory-rules";
import ProductThumb from "./ProductThumb";
import { sampleImage } from "@/lib/theme-preview-samples";
import MediaPicker from "./MediaPicker";
import ProductCopyAssistant from "./ProductCopyAssistant";
import ManagementPageHeader from "./ManagementPageHeader";
import { useToastHelpers } from "@/components/ui/Toast";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { Field, FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill } from "@/components/ui/Surface";
import { confirmDialog } from "@/components/ui/ConfirmDialog";

interface Product {
  _id: string;
  name: string;
  description: string;
  price: number;
  /** Optional original price; the product shows as on sale only when it is higher than `price`. */
  compareAtPrice?: number | null;
  currency: string;
  imageUrl: string;
  images?: string[];
  category: string;
  status: string;
  /** Units available to buy (already net of reserved unpaid orders). */
  stock: number;
  /** Purchasable variants (0 = simple product). */
  variantCount?: number;
  /** The product's own low-stock level (empty = the platform default). */
  lowStockThreshold?: number | null;
  /** Search-engine title/description and main image alt text (empty = derived). */
  seoTitle?: string;
  seoDescription?: string;
  imageAlt?: string;
  /** A starter sample's bundled photo; empty for the owner's own products. */
  sample?: string;
}

const quietDangerClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** One catalogue row: stacks below `xl`; the header row shares the same columns. */
const rowGridClass =
  "grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 xl:grid-cols-[3.5rem_minmax(0,1fr)_6.5rem_8rem_5rem_17.5rem] xl:gap-x-4";

function StockPill({ stock, threshold }: { stock: number; threshold?: number | null }) {
  const state = availabilityOf(stock, threshold);
  if (state === "out_of_stock") return <Pill tone="danger" dot>Out of stock</Pill>;
  if (state === "low_stock") return <Pill tone="warning" dot>Low: {stock} left</Pill>;
  return <Pill dot>{stock} in stock</Pill>;
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${used >= limit ? "bg-amber-500" : "bg-slate-900"}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A titled group of fields: the title sits beside the fields on wide screens. */
function FormSection({ title, hint, level = "h3", children }: { title: string; hint?: string; level?: "h3" | "h4"; children: ReactNode }) {
  const Heading = level;
  return (
    <div className="grid gap-4 border-t border-slate-200 py-5 first:border-t-0 first:pt-0 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-6">
      <div>
        <Heading className="text-sm font-semibold text-slate-900">{title}</Heading>
        {hint && <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>}
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function EmptyFilteredState({ onClear }: { onClear: () => void }) {
  return (
    <div className="px-4 py-12 text-center sm:px-6">
      <Icon name="search" size={28} className="mx-auto text-slate-400" />
      <h3 className="mt-3 text-base font-semibold text-slate-900">No products match your search</h3>
      <p className="mt-1 text-sm text-slate-600">Try a different search term or clear the filters.</p>
      <Button variant="secondary" onClick={onClear} className="mt-4">
        Clear filters
      </Button>
    </div>
  );
}

export default function ProductsManager({
  businessId,
  initialProducts,
  currency,
  canArchive,
  canViewBilling = false,
  categoryOptions = [],
  entitlements,
  aiState = "off",
}: {
  businessId: string;
  initialProducts: Product[];
  currency: string;
  canArchive: boolean;
  /** Billing is owner-only: everyone else is told who can change the plan. */
  canViewBilling?: boolean;
  /** Managed category names (suggestions; free text still allowed). */
  categoryOptions?: string[];
  entitlements: { planName: string; productLimit: number; active: boolean };
  /** AI writing help: platform availability and this store's consent (server-decided). */
  aiState?: "off" | "needs_consent" | "on";
}) {
  const router = useRouter();
  const { success, error } = useToastHelpers();
  const formId = useId();
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [addOpen, setAddOpen] = useState(initialProducts.length === 0);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [compareAt, setCompareAt] = useState("");
  const [stock, setStock] = useState("");
  const [category, setCategory] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editCompareAt, setEditCompareAt] = useState("");
  const [editStock, setEditStock] = useState("");
  /** Stock value shown when editing started; sent so the server can detect concurrent orders. */
  const [editStockBaseline, setEditStockBaseline] = useState(0);
  const [editCategory, setEditCategory] = useState("");
  const [editImageUrl, setEditImageUrl] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSeoTitle, setEditSeoTitle] = useState("");
  const [editSeoDescription, setEditSeoDescription] = useState("");
  const [editImageAlt, setEditImageAlt] = useState("");
  const [editStatus, setEditStatus] = useState<"draft" | "active">("active");
  const [editError, setEditError] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [addFields, setAddFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "draft">("all");
  const [editImages, setEditImages] = useState<string[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<Product[] | null>(null);

  const atLimit = products.length >= entitlements.productLimit;
  const samples = products.filter((product) => product.sample);
  const [samplesBusy, setSamplesBusy] = useState(false);

  /** Adds this store's starter samples, or archives the ones still unchanged. */
  async function changeSamples(action: "add" | "remove") {
    if (action === "remove" && !(await confirmDialog({ title: "Remove the sample products?", message: "Samples you have not changed yet are archived. Products you made your own stay.", confirmLabel: "Remove samples" }))) return;
    setSamplesBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/samples`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(apiErrorFrom(data, "That did not work. Try again.").message);
      if (action === "remove") {
        setProducts((current) => current.filter((product) => !product.sample));
        success("Samples removed", "Only your own products are left.");
      } else {
        const list = await fetch(`/api/businesses/${businessId}/products`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (list?.products) setProducts(list.products as Product[]);
        success(data?.added ? "Samples added" : "No samples added", data?.added ? "Open each one and put in your own name, price and photo." : "There are no samples for this kind of business, or your plan has no room for more products.");
      }
      router.refresh();
    } catch (err) {
      error("Samples", err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setSamplesBusy(false);
    }
  }

  const nameId = `${formId}-name`;
  const priceId = `${formId}-price`;
  const categoryId = `${formId}-category`;
  const imageId = `${formId}-image`;
  const descriptionId = `${formId}-description`;
  const addPanelId = `${formId}-add-panel`;

  const searchId = `${formId}-search`;
  const categoryFilterId = `${formId}-category-filter`;
  const statusFilterId = `${formId}-status-filter`;
  const billingHref = `/dashboard/businesses/${businessId}/billing`;

  const categories = useMemo(() => {
    const unique = new Set<string>();
    for (const product of products) {
      const value = product.category?.trim();
      if (value) unique.add(value);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [products]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((product) => {
      if (statusFilter !== "all" && product.status !== statusFilter) return false;
      if (categoryFilter !== "all" && (product.category ?? "") !== categoryFilter) {
        return false;
      }
      if (!query) return true;
      return (
        product.name.toLowerCase().includes(query) ||
        (product.description ?? "").toLowerCase().includes(query) ||
        (product.category ?? "").toLowerCase().includes(query)
      );
    });
  }, [products, search, statusFilter, categoryFilter]);

  const filtersActive =
    search.trim() !== "" || categoryFilter !== "all" || statusFilter !== "all";

  useEffect(() => {
    if (categoryFilter !== "all" && !categories.includes(categoryFilter)) {
      setCategoryFilter("all");
    }
  }, [categories, categoryFilter]);

  // Links to "#add-product" (the header button, the command palette) open the form.
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === "#add-product") setAddOpen(true);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  function openAddForm() {
    setAddOpen(true);
    window.requestAnimationFrame(() => document.getElementById(nameId)?.focus());
  }

  function clearFilters() {
    setSearch("");
    setCategoryFilter("all");
    setStatusFilter("all");
  }

  async function addProduct(event: React.FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      error("Product name is required.", "Please enter a product name.");
      return;
    }
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      error("Invalid price", "Enter a valid price of 0 or more.");
      return;
    }
    const parsedStock = stock.trim() === "" ? 0 : Number(stock);
    if (!Number.isSafeInteger(parsedStock) || parsedStock < 0) {
      error("Invalid stock", "Enter a whole number of 0 or more.");
      return;
    }
    const parsedCompareAt = compareAt.trim() === "" ? null : Number(compareAt);
    if (parsedCompareAt !== null && (!Number.isFinite(parsedCompareAt) || parsedCompareAt <= parsedPrice)) {
      error("Invalid original price", "The original price must be higher than the price, or left empty.");
      return;
    }

    setLoading(true);
    setAddFields({});
    try {
      const res = await fetch(`/api/businesses/${businessId}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          price: parsedPrice,
          compareAtPrice: parsedCompareAt,
          stock: parsedStock,
          category: category || undefined,
          imageUrl: imageUrl || undefined,
          description: description || undefined,
          status: "active",
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { product?: Product; error?: string }
        | null;
      if (!res.ok) {
        const info = apiErrorFrom(data, "Unable to add product");
        setAddFields(info.fields);
        throw new Error(summaryMessage(info, ["name", "category", "description", "price", "compareAtPrice", "stock", "imageUrl"]));
      }
      if (data?.product) {
        setProducts((current) => [data.product as Product, ...current]);
      }
      setName("");
      setPrice("");
      setCompareAt("");
      setStock("");
      setCategory("");
      setImageUrl("");
      setDescription("");
      success("Product added", `"${data?.product?.name || "New product"}" has been created.`);
      router.refresh();
    } catch (err) {
      error("Unable to add product", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function duplicateProduct(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/${id}/duplicate`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string; product?: Product } | null;
      if (!res.ok || !data?.product) {
        error("Unable to copy product", data?.error ?? "Please try again.");
        return;
      }
      setProducts((current) => [data.product as Product, ...current]);
      success("Product copied", `"${data.product.name}" is a draft with no stock yet.`);
      router.refresh();
    } catch {
      error("Network error", "The product was not copied.");
    } finally {
      setBusyId(null);
    }
  }

  async function loadArchived() {
    setArchivedOpen((open) => !open);
    if (archived !== null) return;
    try {
      const res = await fetch(`/api/businesses/${businessId}/products?status=archived`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { products?: Product[] } | null;
      setArchived(data?.products ?? []);
    } catch {
      setArchived([]);
    }
  }

  async function restoreProduct(product: Product) {
    setBusyId(product._id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/${product._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "draft" }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; product?: Product } | null;
      if (!res.ok || !data?.product) {
        error("Unable to restore product", data?.error ?? "Please try again.");
        return;
      }
      setArchived((current) => (current ?? []).filter((item) => item._id !== product._id));
      setProducts((current) => [data.product as Product, ...current]);
      success("Product restored", `"${product.name}" is back as a draft. Publish it when you are ready.`);
      router.refresh();
    } catch {
      error("Network error", "The product was not restored.");
    } finally {
      setBusyId(null);
    }
  }

  async function archiveProduct(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/${id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        error("Unable to archive product", data?.error ?? "Please try again.");
        return;
      }
      const archived = products.find((item) => item._id === id);
      setProducts((current) => current.filter((item) => item._id !== id));
      success("Product archived", archived ? `"${archived.name}" was archived.` : "Product archived.");
      router.refresh();
    } catch {
      error("Network error", "The product list was not changed.");
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(product: Product) {
    setEditingId(product._id);
    setEditFields({});
    setEditName(product.name);
    setEditPrice(String(product.price));
    setEditCompareAt(typeof product.compareAtPrice === "number" ? String(product.compareAtPrice) : "");
    setEditStock(String(product.stock ?? 0));
    setEditStockBaseline(product.stock ?? 0);
    setEditCategory(product.category);
    setEditImageUrl(product.imageUrl);
    setEditImages(product.images ?? []);
    setEditDescription(product.description);
    setEditSeoTitle(product.seoTitle ?? "");
    setEditSeoDescription(product.seoDescription ?? "");
    setEditImageAlt(product.imageAlt ?? "");
    setEditStatus(product.status === "draft" ? "draft" : "active");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(event: React.FormEvent, productId: string) {
    event.preventDefault();
    if (saving) return;

    const trimmedName = editName.trim();
    if (!trimmedName) {
      setEditError("Product name is required.");
      return;
    }
    const parsedPrice = Number(editPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setEditError("Enter a valid price of 0 or more.");
      return;
    }
    const parsedStock = Number(editStock);
    if (!Number.isSafeInteger(parsedStock) || parsedStock < 0) {
      setEditError("Stock must be a whole number of 0 or more.");
      return;
    }
    const parsedCompareAt = editCompareAt.trim() === "" ? null : Number(editCompareAt);
    if (parsedCompareAt !== null && (!Number.isFinite(parsedCompareAt) || parsedCompareAt <= parsedPrice)) {
      setEditError("The original price must be higher than the price, or left empty.");
      return;
    }
    const stockChanged = parsedStock !== editStockBaseline;

    setSaving(true);
    setEditError(null);
    setEditFields({});
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          price: parsedPrice,
          compareAtPrice: parsedCompareAt,
          category: editCategory.trim(),
          imageUrl: editImageUrl.trim(),
          images: editImages,
          description: editDescription.trim(),
          seoTitle: editSeoTitle.trim(),
          seoDescription: editSeoDescription.trim(),
          imageAlt: editImageAlt.trim(),
          status: editStatus,
          // Only send stock when the owner changed it, with the value they saw,
          // so an order placed meanwhile is never silently overwritten.
          ...(stockChanged ? { stock: parsedStock, expectedStock: editStockBaseline } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { product?: Product; error?: string }
        | null;
      if (res.status === 409) {
        // Orders reserve stock while the form is open. Fetch the current value
        // so the next save compares against it, and keep the owner's input.
        const current = await fetch(`/api/businesses/${businessId}/products`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { products?: Product[] } | null) =>
            d?.products?.find((item) => String(item._id) === productId),
          )
          .catch(() => undefined);
        if (current) {
          setEditStockBaseline(current.stock ?? 0);
          setProducts((list) =>
            list.map((item) => (item._id === productId ? { ...item, stock: current.stock ?? 0 } : item)),
          );
          setEditError(
            `Stock changed to ${current.stock ?? 0} while you were editing (new orders reserve stock). Check the amount and save again. Nothing was saved.`,
          );
        } else {
          setEditError("Stock changed while you were editing. Reload the page and try again. Nothing was saved.");
        }
        return;
      }
      if (!res.ok) {
        const info = apiErrorFrom(data, "Unable to update product");
        setEditFields(info.fields);
        setEditError(summaryMessage(info, ["name", "category", "description", "price", "compareAtPrice", "stock", "imageUrl", "imageAlt", "seoTitle", "seoDescription"]));
        return;
      }
      if (data?.product) {
        const updated = data.product;
        setProducts((current) =>
          current.map((item) => (item._id === productId ? updated : item)),
        );
      }
      setEditingId(null);
      success("Product updated", `"${data?.product?.name || "Product"}" has been saved.`);
      router.refresh();
    } catch {
      setEditError("Network error. Your changes were not saved.");
    } finally {
      setSaving(false);
    }
  }

  const compareOption = canViewBilling ? (
    <ButtonLink href={billingHref} variant="secondary">
      Compare plans
    </ButtonLink>
  ) : undefined;

  return (
    <div className="space-y-6">
      <datalist id={`${formId}-categories`}>
        {categoryOptions.map((name) => <option key={name} value={name} />)}
      </datalist>
      <ManagementPageHeader
        title="Products"
        description="Add and organize the items shown on your website. Draft products stay hidden from visitors until they are active."
        actions={
          <a href="#add-product" onClick={openAddForm} className={buttonClass()}>
            <Icon name="plus" size={16} />
            Add product
          </a>
        }
      />

      <Card as="section" id="add-product" className="scroll-mt-44 p-5 sm:p-6 lg:scroll-mt-32">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <h2 className="text-lg font-semibold text-slate-900">Add a product</h2>
            <p className="mt-1 text-sm text-slate-600">
              Add the key details customers need to understand what you offer.
            </p>
          </div>
          <Button variant="secondary" aria-expanded={addOpen} aria-controls={addPanelId} onClick={() => setAddOpen((open) => !open)}>
            {addOpen ? "Hide form" : "Show form"}
            <Icon name="chevron-down" size={16} className={addOpen ? "rotate-180" : ""} />
          </Button>
        </div>

        <div className="mt-4 max-w-md">
          <div className="mb-1.5 flex flex-wrap justify-between gap-x-3 text-xs text-slate-500">
            <span>
              {products.length} of {entitlements.productLimit} products used
            </span>
            <span>Plan: {entitlements.planName}</span>
          </div>
          <UsageBar used={products.length} limit={entitlements.productLimit} />
        </div>

        {!entitlements.active && (
          <Notice tone="warning" className="mt-4" title="An active subscription is required to add products." action={compareOption}>
            Your existing products are kept. Choose a plan to add more.{canViewBilling ? "" : " The business owner manages the plan."}
          </Notice>
        )}
        {atLimit && entitlements.active && (
          <Notice
            tone="info"
            className="mt-4"
            title={`You have used all ${entitlements.productLimit} products on the ${entitlements.planName} plan.`}
            action={compareOption}
          >
            Everything you have added stays on your store. To add more, {samples.length > 0 ? "make a sample product your own or remove the samples, " : ""}archive a product you no longer sell or move to a
            plan with more room.{canViewBilling ? "" : " The business owner manages the plan."}
          </Notice>
        )}

        <div id={addPanelId} hidden={!addOpen}>
          <form onSubmit={addProduct} noValidate className="mt-5 border-t border-slate-200 pt-5">
            <FormSection title="Basics" hint="What shoppers will see first.">
              <div className="sm:col-span-2">
                <Field label="Product name" error={addFields.name}>
                  <input
                    id={nameId}
                    name="name"
                    autoComplete="off"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Handmade leather wallet…"
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Category (optional)" hint="Group similar products. New names are fine." error={addFields.category}>
                  <input
                    id={categoryId}
                    name="category"
                    autoComplete="off"
                    value={category}
                    list={`${formId}-categories`}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Accessories…"
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Description (optional)" error={addFields.description}>
                  <textarea
                    id={descriptionId}
                    name="description"
                    autoComplete="off"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    placeholder="Describe the product, materials or dimensions…"
                    className={inputClass}
                  />
                </Field>
              </div>
            </FormSection>

            <FormSection title="Pricing and stock" hint="Customers can only buy items that are in stock.">
              <div>
                <label htmlFor={priceId} className={labelClass}>
                  Price
                </label>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-500"
                  >
                    {currency}
                  </span>
                  <input
                    id={priceId}
                    name="price"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    required
                    aria-describedby={addFields.price ? `${priceId}-hint ${fieldErrorId("product", "price")}` : `${priceId}-hint`}
                    aria-invalid={invalidProps(addFields, "price", "product")["aria-invalid"]}
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className={`${inputClass} !pl-14`}
                  />
                </div>
                <p id={`${priceId}-hint`} className="mt-1.5 text-xs text-slate-500">Enter a price of 0 or more.</p>
                <FieldError id={fieldErrorId("product", "price")} message={addFields.price} />
              </div>
              <Field label="Original price (optional)" hint="Only for a real reduction: shown crossed out when higher than the price." error={addFields.compareAtPrice}>
                <input
                  id={`${priceId}-compare`}
                  name="compareAtPrice"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={compareAt}
                  onChange={(e) => setCompareAt(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Quantity in stock" error={addFields.stock}>
                <input
                  id={`${priceId}-stock`}
                  name="stock"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  value={stock}
                  onChange={(e) => setStock(e.target.value)}
                  placeholder="0"
                  className={inputClass}
                />
              </Field>
            </FormSection>

            <FormSection title="Images" hint="Choose an image from your media library or paste a secure HTTPS image link.">
              <div className="min-w-0">
                <Field label="Product image (optional)" error={addFields.imageUrl}>
                  <input
                    id={imageId}
                    name="imageUrl"
                    type="url"
                    value={imageUrl}
                    spellCheck={false}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://…"
                    className={inputClass}
                  />
                </Field>
                <div className="mt-2">
                  <MediaPicker
                    businessId={businessId}
                    selectedUrl={imageUrl}
                    onSelect={(selection) => setImageUrl(selection?.url ?? "")}
                    disabled={loading}
                    contextLabel="product image"
                  />
                </div>
              </div>
              <div>
                <p className={labelClass}>
                  Preview <span className="sr-only">of image URL</span>
                </p>
                {imageUrl.trim() ? (
                  <ProductThumb
                    imageUrl={imageUrl.trim()}
                    name={name || "Product"}
                    sizeClassName="h-24 w-24"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-xl bg-slate-50 text-xs text-slate-500 ring-1 ring-slate-200">
                    No image
                  </div>
                )}
              </div>
            </FormSection>

            <div className="flex flex-col gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-slate-500 sm:max-w-md">
                New products are active right away, so visitors can see them on your published store. Options, variants and
                search text can be added once the product exists.
              </p>
              <Button type="submit" disabled={loading || atLimit || !entitlements.active} className="w-full shrink-0 sm:w-auto">
                {loading ? "Adding…" : "Add product"}
              </Button>
            </div>
          </form>
        </div>
      </Card>

      {samples.length > 0 && (
        <Notice
          tone="info"
          title={`${samples.length} sample product${samples.length === 1 ? "" : "s"} to get you started`}
          action={<Button variant="secondary" disabled={samplesBusy} onClick={() => void changeSamples("remove")}>{samplesBusy ? "Removing…" : "Remove samples"}</Button>}
        >
          Shoppers never see samples. Press <strong>Make it yours</strong> on one, change its name, price or photo to your own, then set it to Active to sell it.
        </Notice>
      )}

      {products.length === 0 ? (
        <EmptyState
          icon={<Icon name="products" size={20} />}
          title="No products yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={openAddForm} disabled={atLimit || !entitlements.active}>
                Add your first product
              </Button>
              <Button variant="secondary" onClick={() => void changeSamples("add")} disabled={samplesBusy || atLimit || !entitlements.active}>
                {samplesBusy ? "Adding…" : "Start with sample products"}
              </Button>
            </div>
          }
        >
          Products are what shoppers browse and buy on your store. Add one with a name, a price and a photo, and you can
          refine it later.
        </EmptyState>
      ) : (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-4 sm:px-6">
            <h2 className="text-lg font-semibold text-slate-900">Product catalog</h2>
            <span className="text-sm text-slate-500">
              {products.length} of {entitlements.productLimit} products
            </span>
          </div>
          <div className="border-b border-slate-200 px-4 py-4 sm:px-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Search products">
                  <input
                    id={searchId}
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, description or category"
                    className={inputClass}
                  />
                </Field>
              </div>
              <Field label="Category">
                <select
                  id={categoryFilterId}
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className={inputClass}
                >
                  <option value="all">All categories</option>
                  {categories.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select
                  id={statusFilterId}
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as "all" | "active" | "draft")
                  }
                  className={inputClass}
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active (on sale)</option>
                  <option value="draft">Draft (hidden from shoppers)</option>
                </select>
              </Field>
            </div>
            <div className="mt-3 flex min-h-10 flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-500">
                Showing {filteredProducts.length} of {products.length}{" "}
                {products.length === 1 ? "product" : "products"}
              </p>
              {filtersActive && (
                <Button variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </div>
          {filteredProducts.length === 0 ? (
            <EmptyFilteredState onClear={clearFilters} />
          ) : (
            <>
              <div aria-hidden="true" className={`${rowGridClass} hidden bg-slate-50 px-6 py-2.5 text-xs font-medium text-slate-500 xl:grid`}>
                <span className="col-span-2">Product</span>
                <span>Price</span>
                <span>Stock</span>
                <span>Status</span>
                <span />
              </div>
              <ul className="divide-y divide-slate-100">
                {filteredProducts.map((product) => {
                  const isEditing = editingId === product._id;
                  const editBase = `${formId}-edit-${product._id}`;
                  const details = [product.category, product.variantCount ? `${product.variantCount} variants` : null].filter(Boolean).join(" · ");
                  return (
                    <li key={product._id}>
                      <div className={`${rowGridClass} px-4 py-4 transition-colors hover:bg-slate-50 sm:px-6`}>
                        <ProductThumb
                          key={product.imageUrl || product.sample || "no-image"}
                          imageUrl={product.imageUrl || (product.sample ? sampleImage(product.sample) : "")}
                          name={product.name}
                          sizeClassName="h-14 w-14"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{product.name}</p>
                          <p className="truncate text-sm text-slate-500">{details || "No category"}</p>
                        </div>
                        <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 xl:contents">
                          <p className="text-sm font-semibold tabular-nums text-slate-900">
                            {formatPrice(product.price, product.currency || currency)}
                            {typeof product.compareAtPrice === "number" && product.compareAtPrice > product.price && (
                              <span className="ml-1.5 text-xs font-normal text-slate-500 xl:ml-0 xl:block">
                                <span className="sr-only">was </span>
                                <s>{formatPrice(product.compareAtPrice, product.currency || currency)}</s>
                              </span>
                            )}
                          </p>
                          <div>
                            <StockPill stock={product.stock ?? 0} threshold={product.lowStockThreshold} />
                          </div>
                          <div aria-label={`Status: ${product.status}`} role="group">
                            <Pill tone={product.status === "active" ? "success" : "neutral"}>
                              {product.status === "active" ? "On sale" : product.status === "draft" ? "Hidden" : product.status}
                            </Pill>
                            {product.sample && <Pill tone="warning" className="ml-1.5">Sample</Pill>}
                          </div>
                        </div>
                        <div className="col-span-2 flex flex-wrap items-center gap-2 xl:col-span-1 xl:justify-end">
                          {!isEditing && (
                            <>
                              <Button variant="secondary" onClick={() => startEdit(product)} disabled={busyId === product._id}>
                                {product.sample ? "Make it yours" : "Edit"}
                              </Button>
                              <Link href={`/dashboard/businesses/${businessId}/products/${product._id}/variants`} className={buttonClass({ variant: "ghost" })}>
                                {product.variantCount ? `Variants (${product.variantCount})` : "Options"}
                              </Link>
                              <Button variant="ghost" onClick={() => void duplicateProduct(product._id)} disabled={busyId === product._id}>
                                Duplicate
                              </Button>
                              {canArchive && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const confirmed = await confirmDialog({ title: `Archive ${product.name}?`, message: "It comes off your store and your catalog. Past orders keep their details.", confirmLabel: "Archive product", tone: "danger" });
                                    if (confirmed) void archiveProduct(product._id);
                                  }}
                                  disabled={busyId === product._id}
                                  aria-busy={busyId === product._id}
                                  className={quietDangerClass}
                                >
                                  {busyId === product._id ? "Archiving…" : "Archive"}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {isEditing && (
                        <form
                          onSubmit={(event) => saveEdit(event, product._id)}
                          aria-label={`Edit ${product.name}`}
                          className="border-t border-slate-200 bg-slate-50 p-4 sm:p-6"
                        >
                          <h3 className="mb-4 text-base font-semibold text-slate-900">
                            {product.sample ? "Make this sample yours" : "Edit product"}
                          </h3>
                          {product.sample && (
                            <Notice tone="info" className="mb-4">
                              This is a sample, and shoppers never see it. Put in your own name, price and photo (at least one of them), then choose Active to sell it.
                            </Notice>
                          )}

                          <FormSection level="h4" title="Basics" hint="Active products are visible on your published store. Drafts stay hidden.">
                            <div className="sm:col-span-2">
                              <Field label="Name" error={editFields.name}>
                                <input
                                  id={`${editBase}-name`}
                                  required
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  disabled={saving}
                                  className={inputClass}
                                />
                              </Field>
                            </div>
                            <Field label="Category" error={editFields.category}>
                              <input
                                id={`${editBase}-category`}
                                value={editCategory}
                                list={`${formId}-categories`}
                                onChange={(e) => setEditCategory(e.target.value)}
                                disabled={saving}
                                className={inputClass}
                              />
                            </Field>
                            <Field label="Status">
                              <select
                                id={`${editBase}-status`}
                                value={editStatus}
                                onChange={(e) =>
                                  setEditStatus(e.target.value as "draft" | "active")
                                }
                                disabled={saving}
                                className={inputClass}
                              >
                                <option value="active">Active (on sale)</option>
                                <option value="draft">Draft (hidden from shoppers)</option>
                              </select>
                            </Field>
                            <div className="sm:col-span-2">
                              <Field label="Description" error={editFields.description}>
                                <textarea
                                  id={`${editBase}-description`}
                                  value={editDescription}
                                  onChange={(e) => setEditDescription(e.target.value)}
                                  rows={3}
                                  disabled={saving}
                                  className={inputClass}
                                />
                              </Field>
                              <ProductCopyAssistant
                                businessId={businessId}
                                productId={product._id}
                                aiState={aiState}
                                disabled={saving}
                                onUse={({ description: text, name: suggestedName, seoTitle, seoDescription }) => {
                                  setEditDescription(text);
                                  if (suggestedName) setEditName(suggestedName);
                                  if (seoTitle) setEditSeoTitle(seoTitle);
                                  if (seoDescription) setEditSeoDescription(seoDescription);
                                }}
                              />
                            </div>
                          </FormSection>

                          <FormSection level="h4" title="Pricing and stock" hint="Stock already excludes units reserved by unpaid orders.">
                            <Field label={`Price (${product.currency || currency})`} error={editFields.price}>
                              <input
                                id={`${editBase}-price`}
                                type="number"
                                min="0"
                                step="0.01"
                                required
                                value={editPrice}
                                onChange={(e) => setEditPrice(e.target.value)}
                                disabled={saving}
                                className={inputClass}
                              />
                            </Field>
                            <Field label="Original price (optional)" hint="Only for a real reduction: shown crossed out when higher than the price." error={editFields.compareAtPrice}>
                              <input
                                id={`${editBase}-compare`}
                                type="number"
                                min="0"
                                step="0.01"
                                value={editCompareAt}
                                onChange={(e) => setEditCompareAt(e.target.value)}
                                disabled={saving}
                                className={inputClass}
                              />
                            </Field>
                            <Field label="Quantity in stock" hint={product.variantCount ? "Stock is set per variant on the Inventory page." : undefined} error={editFields.stock}>
                              <input
                                id={`${editBase}-stock`}
                                type="number"
                                min="0"
                                step="1"
                                required
                                value={editStock}
                                onChange={(e) => setEditStock(e.target.value)}
                                // Variant stock is managed per variant on the Inventory page.
                                disabled={saving || Boolean(product.variantCount)}
                                title={product.variantCount ? "Stock is set per variant on the Inventory page" : undefined}
                                className={inputClass}
                              />
                            </Field>
                          </FormSection>

                          <FormSection level="h4" title="Images" hint="The main photo shown in your catalogue and on the product page.">
                            <div className="sm:col-span-2">
                              <div className="flex flex-wrap items-start gap-3">
                                <div className="min-w-0 flex-1 basis-56">
                                  <Field label="Image URL" error={editFields.imageUrl}>
                                    <input
                                      id={`${editBase}-image`}
                                      value={editImageUrl}
                                      onChange={(e) => setEditImageUrl(e.target.value)}
                                      placeholder="https://…"
                                      disabled={saving}
                                      className={inputClass}
                                    />
                                  </Field>
                                  <div className="mt-2">
                                    <MediaPicker
                                      businessId={businessId}
                                      selectedUrl={editImageUrl}
                                      onSelect={(selection) =>
                                        setEditImageUrl(selection?.url ?? "")
                                      }
                                      disabled={saving}
                                      contextLabel="product image"
                                    />
                                  </div>
                                </div>
                                <ProductThumb
                                  imageUrl={editImageUrl.trim()}
                                  name={editName || "Product"}
                                  sizeClassName="h-24 w-24"
                                />
                              </div>
                            </div>
                            <div className="sm:col-span-2">
                              <p className="text-sm font-medium text-slate-800">More photos ({editImages.length}/10)</p>
                              <p className="mt-0.5 text-xs text-slate-500">Shown in the gallery on the product page, in this order, after the main image.</p>
                              {editImages.length > 0 && (
                                <ul className="mt-2 flex flex-wrap gap-2">
                                  {editImages.map((url, index) => (
                                    <li key={url} className="w-24 rounded-lg border border-slate-200 bg-white p-1">
                                      <ProductThumb imageUrl={url} name={`${editName || "Product"} photo ${index + 1}`} sizeClassName="h-20 w-full" />
                                      <div className="mt-1 flex items-center justify-between">
                                        <button
                                          type="button"
                                          disabled={index === 0 || saving}
                                          aria-label={`Move photo ${index + 1} earlier`}
                                          onClick={() => setEditImages((all) => { const next = [...all]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}
                                          className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                                        >
                                          <Icon name="arrow-left" size={14} />
                                        </button>
                                        <button
                                          type="button"
                                          disabled={saving}
                                          aria-label={`Remove photo ${index + 1}`}
                                          onClick={() => setEditImages((all) => all.filter((_, i) => i !== index))}
                                          className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-red-50 hover:text-red-700"
                                        >
                                          <Icon name="x" size={14} />
                                        </button>
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {editImages.length < 10 && (
                                <div className="mt-2">
                                  <MediaPicker
                                    businessId={businessId}
                                    selectedUrl=""
                                    buttonLabel="Add a photo"
                                    onSelect={(selection) => {
                                      if (selection?.url) setEditImages((all) => (all.includes(selection.url) ? all : [...all, selection.url]));
                                    }}
                                    disabled={saving}
                                    contextLabel="product gallery photo"
                                  />
                                </div>
                              )}
                            </div>
                            <div className="sm:col-span-2">
                              <Field label="Describe the photo (optional)" hint="Describes the photo for people using screen readers." error={editFields.imageAlt}>
                                <input id={`${editBase}-alt`} value={editImageAlt} maxLength={160} onChange={(e) => setEditImageAlt(e.target.value)} disabled={saving} className={inputClass} />
                              </Field>
                            </div>
                          </FormSection>

                          <FormSection level="h4" title="Variants" hint="Sizes, colours and other choices, each with its own stock.">
                            <div className="sm:col-span-2">
                              <p className="text-sm text-slate-700">
                                {product.variantCount
                                  ? `This product has ${product.variantCount} variants for sale.`
                                  : "This product is sold as one item, with no options."}
                              </p>
                              <Link href={`/dashboard/businesses/${businessId}/products/${product._id}/variants`} className={`mt-2 ${buttonClass({ variant: "secondary" })}`}>
                                {product.variantCount ? `Variants (${product.variantCount})` : "Options"}
                              </Link>
                              <p className="mt-2 text-xs text-slate-500">This opens a separate page. Save your changes here first.</p>
                            </div>
                          </FormSection>

                          <FormSection level="h4" title="How it shows on Google" hint="Left empty, these come from the product name and description.">
                            <div className="sm:col-span-2">
                              <Field label="Title on Google (optional)" hint={`${editSeoTitle.length}/160 characters`} error={editFields.seoTitle}>
                                <input id={`${editBase}-seo-title`} value={editSeoTitle} maxLength={160} onChange={(e) => setEditSeoTitle(e.target.value)} disabled={saving} className={inputClass} />
                              </Field>
                            </div>
                            <div className="sm:col-span-2">
                              <Field label="Description on Google (optional)" hint={`${editSeoDescription.length}/320 characters`} error={editFields.seoDescription}>
                                <textarea id={`${editBase}-seo-description`} rows={2} value={editSeoDescription} maxLength={320} onChange={(e) => setEditSeoDescription(e.target.value)} disabled={saving} className={inputClass} />
                              </Field>
                            </div>
                          </FormSection>

                          {editError && (
                            <Notice tone="danger" role="alert" className="mb-4">
                              {editError}
                            </Notice>
                          )}
                          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
                            <Button type="submit" disabled={saving}>
                              {saving ? "Saving…" : "Save changes"}
                            </Button>
                            <Button variant="secondary" onClick={cancelEdit} disabled={saving}>
                              Cancel
                            </Button>
                          </div>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      )}

      {canArchive && (
        <Card className="p-4 sm:p-5">
          <button type="button" aria-expanded={archivedOpen} onClick={() => void loadArchived()} className="flex min-h-10 w-full items-center justify-between gap-3 rounded-lg text-left text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            Archived products
            <Icon name={archivedOpen ? "chevron-up" : "chevron-down"} size={16} className="text-slate-500" />
          </button>
          {archivedOpen && (
            archived === null ? (
              <p role="status" className="mt-2 text-sm text-slate-500">Loading…</p>
            ) : archived.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">Nothing is archived.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100">
                {archived.map((product) => (
                  <li key={product._id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <ProductThumb imageUrl={product.imageUrl} name={product.name} sizeClassName="h-10 w-10" />
                      <p className="min-w-0 truncate text-sm font-medium text-slate-900">{product.name}</p>
                    </div>
                    <Button variant="secondary" disabled={busyId === product._id} onClick={() => void restoreProduct(product)}>
                      {busyId === product._id ? "Restoring…" : "Restore as draft"}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          )}
        </Card>
      )}
    </div>
  );
}
