import { Router, Request, Response } from "express";
import { verifyGupshupWebhookRequest } from "../lib/gupshupWebhookAuth";
import {
  handleDeliveryEvent,
  handleInboundMessage,
  handleMetaV3Payload,
  isMetaV3Payload,
  parseWebhookRoot,
} from "../lib/gupshupWebhook";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, route: "/webhook/gupshup" });
});

router.post("/", async (req: Request, res: Response) => {
  const auth = verifyGupshupWebhookRequest(req);
  if (!auth.ok) {
    res.status(auth.statusCode).json({ error: auth.error });
    return;
  }

  const root = parseWebhookRoot(req.body);
  const type = String(root.type || "").toLowerCase();

  try {
    if (isMetaV3Payload(root)) {
      await handleMetaV3Payload(root);
    } else if (type === "message") {
      await handleInboundMessage(root);
    } else if (type === "message-event") {
      await handleDeliveryEvent(root);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "webhook error";
    console.error("[gupshup webhook]", message);
    res.status(200).json({ received: false });
  }
});

export default router;
