/**
 * DVI SOAP Adapter
 * Connects to DVI RxLab via SOAP API for real-time job data
 *
 * Endpoint: https://dvirx.com:443/DVIRx/services/DVIRxSOAP
 * Protocol: SOAP 1.1
 *
 * Available operations:
 * - DownloadOrders: Get pending orders (newest first)
 * - DownloadStatuses: Get status updates since a date
 * - DownloadJobMessages: Get job messages since a date
 * - LookupByAccount: Search by account/tray/Rx number
 * - GetOrderDetail: Get full order details by order number
 */

import { log } from '../logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface DVIConfig {
  url: string;
  username: string;
  password: string;
  application: string;
}

const CONFIG: DVIConfig = {
  url: process.env.DVI_SOAP_URL || 'https://dvirx.com:443/DVIRx/services/DVIRxSOAP',
  username: process.env.DVI_USERNAME || 'pair',
  password: process.env.DVI_PASSWORD || '',
  application: process.env.DVI_APPLICATION || '65613E2E-7C28-497C-961C-8F8415E5C216',
};

const NAMESPACE = 'http://xmitrx.com/services/DVIRx';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DVIOrder {
  orderNumber: string;
  ordType: string;
  accountId: string;
  remoteInvoice: string;
  rxNumber: string;
  patientId: string;
  rightEye?: DVIRx;
  leftEye?: DVIRx;
  rightLens?: DVILens;
  leftLens?: DVILens;
  frame?: DVIFrame;
  instructions?: string[];
  rawXml?: string;
}

export interface DVIRx {
  sphere: number;
  cylinder: number;
  axis: number;
  pd: number;
  add?: number;
  segHeight?: number;
}

export interface DVILens {
  material: string;
  style: string;
  color: string;
  coating: string;
  type: string;
}

export interface DVIFrame {
  style: string;
  sku: string;
  status: string;
}

export interface DVIStatus {
  orderNumber: string;
  ordType: string;
  remoteInvoice: string;
  rxNumber: string;
  patientName: string;
  statusDesc: string;
  statusDate: string;
  ordStat: string;
  uuid: string;
  destId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOAP Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildLoginXml(): string {
  return `<Login>
    <rxpo:Name>${CONFIG.username}</rxpo:Name>
    <rxpo:Password>${CONFIG.password}</rxpo:Password>
    <rxpo:Application>${CONFIG.application}</rxpo:Application>
  </Login>`;
}

function buildEnvelope(operation: string, body: string): string {
  return `<?xml version="1.0" encoding="iso-8859-1" ?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:dvir="${NAMESPACE}" xmlns:rxpo="${NAMESPACE}"
  xmlns="${NAMESPACE}">
<soapenv:Body>
<dvir:${operation}>
${body}
</dvir:${operation}>
</soapenv:Body>
</soapenv:Envelope>`;
}

async function callSoap(operation: string, body: string): Promise<string> {
  const envelope = buildEnvelope(operation, body);

  const response = await fetch(CONFIG.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': `"${NAMESPACE}/${operation}"`,
    },
    body: envelope,
  });

  if (!response.ok) {
    throw new Error(`DVI SOAP error: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Parsing Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function unescapeXml(xml: string): string {
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseJobXml(escapedXml: string): Partial<DVIOrder> {
  const xml = unescapeXml(escapedXml);

  const result: Partial<DVIOrder> = {
    rawXml: xml,
  };

  // Patient
  result.patientId = extractTag(xml, 'Name');
  result.remoteInvoice = extractTag(xml, 'RmtInv');
  result.rxNumber = extractTag(xml, 'RxNum');

  // Parse Right Eye Rx
  const rightRxMatch = xml.match(/<Rx Eye="R">([\s\S]*?)<\/Rx>/i);
  if (rightRxMatch) {
    result.rightEye = {
      sphere: parseFloat(extractTag(rightRxMatch[1], 'Sphere')) || 0,
      cylinder: parseFloat(extractTag(rightRxMatch[1], 'Cylinder')) || 0,
      axis: parseFloat(extractAttr(rightRxMatch[1], 'Cylinder', 'Axis')) || 0,
      pd: parseFloat(extractTag(rightRxMatch[1], 'PD')) || 0,
    };
    const addPower = extractTag(rightRxMatch[1], 'Power');
    if (addPower) result.rightEye.add = parseFloat(addPower);
    const segHeight = extractTag(rightRxMatch[1], 'SegHeight');
    if (segHeight) result.rightEye.segHeight = parseFloat(segHeight);
  }

  // Parse Left Eye Rx
  const leftRxMatch = xml.match(/<Rx Eye="L">([\s\S]*?)<\/Rx>/i);
  if (leftRxMatch) {
    result.leftEye = {
      sphere: parseFloat(extractTag(leftRxMatch[1], 'Sphere')) || 0,
      cylinder: parseFloat(extractTag(leftRxMatch[1], 'Cylinder')) || 0,
      axis: parseFloat(extractAttr(leftRxMatch[1], 'Cylinder', 'Axis')) || 0,
      pd: parseFloat(extractTag(leftRxMatch[1], 'PD')) || 0,
    };
    const addPower = extractTag(leftRxMatch[1], 'Power');
    if (addPower) result.leftEye.add = parseFloat(addPower);
    const segHeight = extractTag(leftRxMatch[1], 'SegHeight');
    if (segHeight) result.leftEye.segHeight = parseFloat(segHeight);
  }

  // Parse Right Lens
  const rightLensMatch = xml.match(/<Lens Eye="R"[^>]*>([\s\S]*?)<\/Lens>/i);
  if (rightLensMatch) {
    result.rightLens = {
      material: extractTag(rightLensMatch[1], 'Mat'),
      style: extractTag(rightLensMatch[1], 'Style'),
      color: extractTag(rightLensMatch[1], 'Color'),
      coating: extractTag(rightLensMatch[1], 'Coat'),
      type: extractAttr(rightLensMatch[0], 'Lens', 'Type'),
    };
  }

  // Parse Left Lens
  const leftLensMatch = xml.match(/<Lens Eye="L"[^>]*>([\s\S]*?)<\/Lens>/i);
  if (leftLensMatch) {
    result.leftLens = {
      material: extractTag(leftLensMatch[1], 'Mat'),
      style: extractTag(leftLensMatch[1], 'Style'),
      color: extractTag(leftLensMatch[1], 'Color'),
      coating: extractTag(leftLensMatch[1], 'Coat'),
      type: extractAttr(leftLensMatch[0], 'Lens', 'Type'),
    };
  }

  // Parse Frame
  const frameMatch = xml.match(/<Frame[^>]*>([\s\S]*?)<\/Frame>/i);
  if (frameMatch) {
    result.frame = {
      style: extractTag(frameMatch[1], 'Style'),
      sku: extractTag(frameMatch[1], 'SKU'),
      status: extractAttr(frameMatch[0], 'Frame', 'Status'),
    };
  }

  // Parse Instructions
  const instructionMatches = xml.matchAll(/<Instruction[^>]*>([^<]*)<\/Instruction>/gi);
  result.instructions = [...instructionMatches].map(m => m[1]);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download pending orders from DVI
 */
export async function downloadOrders(maxOrders: number = 100): Promise<DVIOrder[]> {
  if (!CONFIG.password) {
    log.info('[DVI] No password configured - returning empty');
    return [];
  }

  const body = `${buildLoginXml()}
<MaxOrders>${maxOrders}</MaxOrders>`;

  try {
    const response = await callSoap('DownloadOrders', body);
    const orders: DVIOrder[] = [];

    // Parse each Order element
    const orderMatches = response.matchAll(/<Order OrdTyp="([^"]*)">([\s\S]*?)<\/Order>/gi);

    for (const match of orderMatches) {
      const ordType = match[1];
      const orderXml = match[2];

      const orderNumber = extractTag(orderXml, 'OrdNum');
      const accountId = extractTag(orderXml, 'Id');

      // Extract the escaped job XML
      const jobMatch = orderXml.match(/<job[^>]*>([^]*?)<\/job>/i);
      const jobData = jobMatch ? parseJobXml(jobMatch[1]) : {};

      orders.push({
        orderNumber,
        ordType,
        accountId,
        remoteInvoice: jobData.remoteInvoice || '',
        rxNumber: jobData.rxNumber || '',
        patientId: jobData.patientId || '',
        rightEye: jobData.rightEye,
        leftEye: jobData.leftEye,
        rightLens: jobData.rightLens,
        leftLens: jobData.leftLens,
        frame: jobData.frame,
        instructions: jobData.instructions,
        rawXml: jobData.rawXml,
      });
    }

    log.info(`[DVI] Downloaded ${orders.length} orders`);
    return orders;
  } catch (error) {
    log.info(`[DVI] Error downloading orders: ${error}`);
    throw error;
  }
}

/**
 * Download status updates since a given date
 */
export async function downloadStatuses(fromDate?: Date): Promise<DVIStatus[]> {
  if (!CONFIG.password) {
    log.info('[DVI] No password configured - returning empty');
    return [];
  }

  const since = fromDate || new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: last 24h
  const body = `${buildLoginXml()}
<FromDate>${since.toISOString()}</FromDate>`;

  try {
    const response = await callSoap('DownloadStatuses', body);
    const statuses: DVIStatus[] = [];

    // Parse each Rx element (status record)
    const rxMatches = response.matchAll(/<Rx ([^>]+)\/>/gi);

    for (const match of rxMatches) {
      const attrs = match[1];

      statuses.push({
        orderNumber: extractAttr(`<Rx ${attrs}>`, 'Rx', 'OrdNum'),
        ordType: extractAttr(`<Rx ${attrs}>`, 'Rx', 'OrdTyp'),
        remoteInvoice: extractAttr(`<Rx ${attrs}>`, 'Rx', 'RmtInv'),
        rxNumber: extractAttr(`<Rx ${attrs}>`, 'Rx', 'RxNum'),
        patientName: extractAttr(`<Rx ${attrs}>`, 'Rx', 'Patient'),
        statusDesc: extractAttr(`<Rx ${attrs}>`, 'Rx', 'StatDesc'),
        statusDate: extractAttr(`<Rx ${attrs}>`, 'Rx', 'StatDate'),
        ordStat: extractAttr(`<Rx ${attrs}>`, 'Rx', 'OrdStat'),
        uuid: extractAttr(`<Rx ${attrs}>`, 'Rx', 'uuid'),
        destId: extractAttr(`<Rx ${attrs}>`, 'Rx', 'destid'),
      });
    }

    log.info(`[DVI] Downloaded ${statuses.length} statuses since ${since.toISOString()}`);
    return statuses;
  } catch (error) {
    log.info(`[DVI] Error downloading statuses: ${error}`);
    throw error;
  }
}

/**
 * Get job messages since a given date
 */
export async function downloadJobMessages(fromDate?: Date): Promise<any[]> {
  if (!CONFIG.password) {
    log.info('[DVI] No password configured - returning empty');
    return [];
  }

  const since = fromDate || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const body = `${buildLoginXml()}
<FromDate>${since.toISOString()}</FromDate>`;

  try {
    const response = await callSoap('DownloadJobMessages', body);
    // Parse messages from response
    // Format TBD based on actual response structure
    log.info(`[DVI] Downloaded job messages since ${since.toISOString()}`);
    return [];
  } catch (error) {
    log.info(`[DVI] Error downloading job messages: ${error}`);
    throw error;
  }
}

/**
 * Get order detail by order number - includes current station/status
 */
export async function getOrderDetail(orderNumber: string): Promise<any> {
  if (!CONFIG.password) {
    log.info('[DVI] No password configured - returning empty');
    return null;
  }

  const body = `${buildLoginXml()}
<OrdNum>${orderNumber}</OrdNum>`;

  try {
    const response = await callSoap('GetOrderDetail', body);
    log.info(`[DVI] GetOrderDetail response length: ${response.length}`);

    // Return raw response for analysis
    return {
      orderNumber,
      rawResponse: response,
      // Try to extract key fields
      status: extractTag(response, 'Status') || extractTag(response, 'StatDesc'),
      station: extractTag(response, 'Station') || extractTag(response, 'Department'),
    };
  } catch (error) {
    log.info(`[DVI] Error getting order detail: ${error}`);
    throw error;
  }
}

/**
 * Lookup jobs by account, tray, or Rx number
 */
export async function lookupByAccount(query: string, searchType: 'account' | 'tray' | 'rxnum' = 'rxnum'): Promise<any[]> {
  if (!CONFIG.password) {
    log.info('[DVI] No password configured - returning empty');
    return [];
  }

  const searchTag = searchType === 'account' ? 'Account' : searchType === 'tray' ? 'Tray' : 'RxNum';
  const body = `${buildLoginXml()}
<${searchTag}>${query}</${searchTag}>`;

  try {
    const response = await callSoap('LookupByAccount', body);
    log.info(`[DVI] LookupByAccount response length: ${response.length}`);

    // Parse results - format TBD based on actual response
    const results: any[] = [];

    // Try to find Order or Rx elements
    const orderMatches = response.matchAll(/<Order[^>]*>([\s\S]*?)<\/Order>/gi);
    for (const match of orderMatches) {
      results.push({
        rawXml: match[0],
        orderNumber: extractTag(match[1], 'OrdNum'),
        status: extractTag(match[1], 'Status') || extractTag(match[1], 'StatDesc'),
        station: extractTag(match[1], 'Station') || extractTag(match[1], 'Department'),
      });
    }

    return results;
  } catch (error) {
    log.info(`[DVI] Error in lookup: ${error}`);
    throw error;
  }
}

/**
 * Check if DVI connection is configured and working
 */
export async function healthCheck(): Promise<{ ok: boolean; message: string }> {
  if (!CONFIG.password) {
    return { ok: false, message: 'DVI_PASSWORD not configured' };
  }

  try {
    // Try a minimal request
    await downloadStatuses(new Date());
    return { ok: true, message: 'Connected to DVI SOAP API' };
  } catch (error) {
    return { ok: false, message: `DVI connection failed: ${error}` };
  }
}

/**
 * Get DVI stats for AI context
 */
export async function getAIContext(): Promise<string> {
  try {
    const orders = await downloadOrders(50);
    const statuses = await downloadStatuses(new Date(Date.now() - 4 * 60 * 60 * 1000));

    // Count by coating type
    const coatingCounts: Record<string, number> = {};
    for (const order of orders) {
      const coat = order.rightLens?.coating || order.leftLens?.coating || 'UNKNOWN';
      coatingCounts[coat] = (coatingCounts[coat] || 0) + 1;
    }

    // Count by status
    const statusCounts: Record<string, number> = {};
    for (const status of statuses) {
      statusCounts[status.ordStat] = (statusCounts[status.ordStat] || 0) + 1;
    }

    return `DVI Live Data:
- Pending Orders: ${orders.length}
- Coating breakdown: ${Object.entries(coatingCounts).map(([k, v]) => `${k}:${v}`).join(', ')}
- Status updates (4h): ${statuses.length}
- Status breakdown: ${Object.entries(statusCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`;
  } catch (error) {
    return `DVI: Connection error - ${error}`;
  }
}

export default {
  downloadOrders,
  downloadStatuses,
  downloadJobMessages,
  getOrderDetail,
  lookupByAccount,
  healthCheck,
  getAIContext,
};
