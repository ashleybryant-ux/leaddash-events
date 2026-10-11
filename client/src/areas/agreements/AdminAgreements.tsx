/**
 * /admin/e/:eventId/agreements: the event's sponsor, exhibitor and speaker agreements.
 * Every event starts with all three, so they can be reviewed and edited before anyone signs up.
 * `?open=<template id or kind>` opens one (links from Speakers and the Checkout page).
 */
import { useState } from "react";
import { useSearch } from "wouter";
import { trpc } from "../../lib/trpc";
import { AdminPage, useAdminEvent } from "../../shells/AdminShell";
import { AgreementsTab } from "./AgreementsTab";

export function AdminAgreementsScreen() {
  const ev = useAdminEvent();
  const open = new URLSearchParams(useSearch()).get("open");
  const list = trpc.agreements.templates.list.useQuery({ eventId: ev.id });
  const [adding, setAdding] = useState(false);
  const canEdit = !!list.data?.editKinds.length;
  return (
    <AdminPage
      title="Agreements"
      actions={
        canEdit ? (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New agreement
          </button>
        ) : undefined
      }
    >
      <div className="table">
        <AgreementsTab adding={adding} onAdded={() => setAdding(false)} initialOpen={open} />
      </div>
    </AdminPage>
  );
}
