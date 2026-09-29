"""Valida un DTE en JSON (formato OpenFactura) contra los XSD oficiales del SII.

Uso:
    python validar.py <archivo.json> [--xml salida.xml] [--quiet] [--estricto]

El JSON puede ser el cuerpo completo que se manda a POST /v2/dte/document
({"response": [...], "dte": {...}, "custom": ..., "sendEmail": ...}) o solo el
objeto dte ({"Encabezado": {...}, "Detalle": [...], "Referencia": [...]}).
Las llaves de nivel superior que no son "dte" son propias de OpenFactura y no
existen en el formato del SII, por eso no se validan aqui.

Que esquema se usa (sii/, descargado de sii.cl/factura_electronica/factura_mercado/):
    TipoDTE 39, 41            -> boleta/EnvioBOLETA_v11.xsd, tipo BOLETADefType
    TipoDTE 43                -> dte/DTE_v10.xsd, rama Liquidacion
    TipoDTE 110, 111, 112     -> dte/DTE_v10.xsd, rama Exportaciones
    cualquier otro            -> dte/DTE_v10.xsd, rama Documento

Conversion JSON -> XML:
    - Raiz <DTE version="1.0"> en el namespace http://www.sii.cl/SiiDte, con
      <Documento>/<Liquidacion>/<Exportaciones> adentro.
    - Los hijos se emiten en el ORDEN DEL XSD, no en el del JSON (el XSD usa
      xs:sequence y el orden es parte de la validez). Si el orden del JSON difiere
      del XSD se avisa aparte, porque la doc de OpenFactura pide respetarlo.
    - Un arreglo se emite como el elemento repetido (Detalle: [a, b] ->
      <Detalle>a</Detalle><Detalle>b</Detalle>); vale para cualquier nivel
      (CdgItem, ImptoReten, Referencia, DscRcgGlobal, etc.).
    - Una llave del JSON que no existe en el XSD en esa posicion es error: no se
      descarta en silencio.
    - Los numeros se escriben tal como vienen en el JSON (sin notacion cientifica).
    - null se trata como campo ausente, con aviso.

Lo que se IGNORA, porque OpenFactura lo genera o lo reemplaza al emitir:
    - ds:Signature (firma XMLDSig del DTE): la pone OpenFactura con el
      certificado del emisor. Se vuelve opcional en una copia en memoria del XSD.
    - TED (timbre electronico, con el CAF y la firma FRMT): lo arma OpenFactura
      con el folio que asigna. Se vuelve opcional.
    - TmstFirma (fecha-hora de la firma): la pone OpenFactura al firmar. Se
      vuelve opcional.
    - Atributo ID de Documento/Liquidacion/Exportaciones (xs:ID requerido): lo
      pone OpenFactura. Se vuelve opcional.
    - Folio = 0: la doc de OpenFactura exige mandar 0 y el reemplaza por el folio
      real, pero el XSD define FolioType como positiveInteger. Si viene 0 se
      escribe 1 en el XML de prueba; cualquier otro valor se valida tal cual.
    - Boleta: EnvioBOLETA_v11.xsd no declara un elemento raiz para una boleta
      suelta (solo EnvioBOLETA > SetDTE > DTE). Se agrega en memoria un elemento
      global DTE de tipo BOLETADefType. La Caratula y el sobre de envio tampoco se
      validan: los arma OpenFactura.
Los archivos XSD en disco no se modifican.

Ademas del XSD se avisa (sin fallar) si un texto trae caracteres que no existen
en ISO-8859-1, que es la codificacion del XML que OpenFactura envia al SII.

Codigo de salida: 0 valido, 1 invalido, 2 error de uso o de entrada.
"""

import argparse
import copy
import json
import sys
from decimal import Decimal
from pathlib import Path

from lxml import etree

HERE = Path(__file__).resolve().parent
XS = "http://www.w3.org/2001/XMLSchema"
DS = "http://www.w3.org/2000/09/xmldsig#"
SII = "http://www.sii.cl/SiiDte"
Q = "{%s}" % XS

DTE_XSD = HERE / "sii" / "dte" / "DTE_v10.xsd"
BOLETA_XSD = HERE / "sii" / "boleta" / "EnvioBOLETA_v11.xsd"

GENERATED_BY_OPENFACTURA = {"TED", "TmstFirma"}
BOLETA_TYPES = {39, 41}
LIQUIDACION_TYPES = {43}
EXPORT_TYPES = {110, 111, 112}


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def load_dte(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"), parse_float=Decimal)
    except (OSError, ValueError) as exc:
        fail(f"no se pudo leer {path}: {exc}")
    if isinstance(data, dict) and "dte" in data:
        data = data["dte"]
    if not isinstance(data, dict) or "Encabezado" not in data:
        fail("el JSON no tiene un objeto dte con Encabezado")
    return data


def tipo_dte(dte):
    try:
        return int(dte["Encabezado"]["IdDoc"]["TipoDTE"])
    except (KeyError, TypeError, ValueError):
        fail("falta Encabezado.IdDoc.TipoDTE o no es numerico")


def pick_schema(tipo):
    if tipo in BOLETA_TYPES:
        return BOLETA_XSD, "BOLETADefType", "Documento"
    if tipo in LIQUIDACION_TYPES:
        return DTE_XSD, "DTEDefType", "Liquidacion"
    if tipo in EXPORT_TYPES:
        return DTE_XSD, "DTEDefType", "Exportaciones"
    return DTE_XSD, "DTEDefType", "Documento"


def element_decls(container):
    """Declaraciones xs:element hijas directas, en orden, aplanando sequence/choice."""
    out = []
    for child in container:
        if child.tag == Q + "element":
            out.append(child)
        elif child.tag in (Q + "sequence", Q + "choice"):
            out.extend(element_decls(child))
    return out


def model_of(decl):
    ct = decl.find(Q + "complexType")
    if ct is None or ct.find(Q + "simpleContent") is not None:
        return None
    return ct


def decl_name(decl):
    return decl.get("name") or decl.get("ref", "").split(":")[-1]


def patch_schema(tree, root_type, branch):
    """Vuelve opcional en memoria lo que genera OpenFactura. Ver docstring del modulo."""
    root = tree.getroot()
    ct = root.find(f"{Q}complexType[@name='{root_type}']")
    seq = ct.find(Q + "sequence")
    for decl in element_decls(seq):
        if decl.get("ref") == "ds:Signature":
            decl.set("minOccurs", "0")
        if decl.get("name") in ("Documento", "Liquidacion", "Exportaciones"):
            doc_ct = model_of(decl)
            for sub in element_decls(doc_ct):
                if sub.get("name") in GENERATED_BY_OPENFACTURA:
                    sub.set("minOccurs", "0")
            for attr in doc_ct.findall(Q + "attribute"):
                if attr.get("name") == "ID":
                    attr.set("use", "optional")
    if root_type == "BOLETADefType":
        el = etree.SubElement(root, Q + "element")
        el.set("name", "DTE")
        el.set("type", "SiiDte:BOLETADefType")
    branch_decl = next(d for d in element_decls(seq) if d.get("name") == branch)
    return etree.XMLSchema(tree), branch_decl


def scalar_text(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


class Builder:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def fill(self, parent_xml, decl, value, path):
        model = model_of(decl)
        if model is None:
            if isinstance(value, (dict, list)):
                self.errors.append(f"{path}: el XSD espera un valor simple, llego {type(value).__name__}")
                return
            if path.endswith("IdDoc.Folio") and scalar_text(value) == "0":
                value = 1
            text = scalar_text(value)
            try:
                text.encode("iso-8859-1")
            except UnicodeEncodeError:
                bad = sorted({c for c in text if ord(c) > 255})
                self.warnings.append(f"{path}: caracteres fuera de ISO-8859-1 {bad}")
            parent_xml.text = text
            return
        if not isinstance(value, dict):
            self.errors.append(f"{path}: el XSD espera un objeto, llego {type(value).__name__}")
            return
        children = element_decls(model)
        order = [decl_name(c) for c in children]
        known = set(order)
        for key in value:
            if key not in known:
                self.errors.append(f"{path}.{key}: no existe en el XSD en esta posicion")
        present = [k for k in value if k in known]
        expected = [k for k in order if k in value]
        if present != expected:
            self.warnings.append(f"{path}: orden del JSON {present} distinto al del XSD {expected}")
        for child in children:
            name = decl_name(child)
            if name not in value:
                continue
            item = value[name]
            if item is None:
                self.warnings.append(f"{path}.{name}: null, se trata como ausente")
                continue
            items = item if isinstance(item, list) else [item]
            for i, one in enumerate(items):
                sub_path = f"{path}.{name}" + (f"[{i}]" if isinstance(item, list) else "")
                node = etree.SubElement(parent_xml, f"{{{SII}}}{name}")
                self.fill(node, child, one, sub_path)


def build_xml(dte, branch_decl, branch):
    builder = Builder()
    root = etree.Element(f"{{{SII}}}DTE", nsmap={None: SII})
    root.set("version", "1.0")
    doc = etree.SubElement(root, f"{{{SII}}}{branch}")
    builder.fill(doc, branch_decl, dte, "dte")
    return root, builder


def readable_path(el):
    parts = []
    while el is not None and el.getparent() is not None and el.getparent().getparent() is not None:
        name = etree.QName(el).localname
        same = [s for s in el.getparent() if etree.QName(s).localname == name]
        parts.append(f"{name}[{same.index(el)}]" if len(same) > 1 else name)
        el = el.getparent()
    return "dte." + ".".join(reversed(parts))


def main():
    parser = argparse.ArgumentParser(description="Valida un DTE JSON de OpenFactura contra el XSD del SII")
    parser.add_argument("json_file")
    parser.add_argument("--xml", help="escribe el XML generado en este archivo")
    parser.add_argument("--quiet", action="store_true", help="no imprime avisos")
    parser.add_argument("--estricto", action="store_true", help="los avisos (orden de campos, caracteres fuera de ISO-8859-1) cuentan como error")
    args = parser.parse_args()

    dte = load_dte(args.json_file)
    tipo = tipo_dte(dte)
    xsd_path, root_type, branch = pick_schema(tipo)
    schema, branch_decl = patch_schema(etree.parse(str(xsd_path)), root_type, branch)
    xml_root, builder = build_xml(dte, branch_decl, branch)

    if args.xml:
        Path(args.xml).write_bytes(
            etree.tostring(xml_root, pretty_print=True, xml_declaration=True, encoding="ISO-8859-1")
        )

    reparsed = etree.fromstring(etree.tostring(xml_root, pretty_print=True))
    valid = schema.validate(reparsed)
    by_line = {el.sourceline: el for el in reparsed.iter()}
    print(f"TipoDTE {tipo} -> {xsd_path.relative_to(HERE)} ({root_type}/{branch})")
    if not args.quiet:
        for w in builder.warnings:
            print(f"AVISO  {w}")
    for e in builder.errors:
        print(f"ERROR  {e}")
    if not valid:
        for e in schema.error_log:
            el = by_line.get(e.line)
            where = readable_path(el) if el is not None else f"linea {e.line}"
            print(f"XSD    {where}: {e.message.replace('{' + SII + '}', '')}")
    ok = valid and not builder.errors and not (args.estricto and builder.warnings)
    print("VALIDO" if ok else "INVALIDO")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
