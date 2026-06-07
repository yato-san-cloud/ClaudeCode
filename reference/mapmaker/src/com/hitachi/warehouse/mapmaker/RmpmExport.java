package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Data-rescue bridge for the new-app project.
 * Loads a legacy .rmpm (Java-serialized WorldMapMultiFloor) and exports the
 * layout to a language-neutral JSON the new app can read. The route graph is
 * intentionally NOT exported (the new app regenerates it); only the editable
 * layout (the real asset) is rescued.
 *
 * Run:  java -cp "tools;MapMaker_v2.0.jar" com.hitachi.warehouse.mapmaker.RmpmExport in.rmpm [out.json]
 */
public class RmpmExport {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.out.println("usage: RmpmExport <in.rmpm> [out.json]");
            return;
        }
        File in = new File(args[0]);
        File out = args.length >= 2 ? new File(args[1]) : new File(args[0] + ".json");
        WorldMapMultiFloor mf = WorldMapMultiFloor.loadFrom(in);
        if (mf == null) {
            System.out.println("failed to load " + in);
            return;
        }
        List<WorldMapExtension> floors = mf.getWorldMapExtensionList();

        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"source\": ").append(jstr(in.getName())).append(",\n");
        sb.append("  \"unit\": \"mm\",\n");
        sb.append("  \"axes\": \"x-right, y-down, origin top-left\",\n");
        sb.append("  \"floors\": [\n");
        int totalObjs = 0;
        for (int f = 0; f < floors.size(); f++) {
            WorldMapExtension ext = floors.get(f);
            WorldMap map = ext.getWorldMap();
            Coord tl = map.tl();
            Coord br = map.br();
            sb.append("    {\n");
            sb.append("      \"name\": ").append(jstr(ext.getName())).append(",\n");
            sb.append("      \"bounds\": {\"left\":").append(tl.x).append(",\"top\":").append(tl.y)
              .append(",\"right\":").append(br.x).append(",\"bottom\":").append(br.y).append("},\n");
            sb.append("      \"view\": {\"centerX\":").append(ext.getCenterX()).append(",\"centerY\":")
              .append(ext.getCenterY()).append(",\"zoom\":").append(ext.getZoomLevel()).append("},\n");
            sb.append("      \"objects\": [\n");

            List<AbstractObject> objs = new ArrayList<AbstractObject>();
            try {
                map.startRead();
                for (AbstractObject o : map.objects()) {
                    objs.add(o);
                }
            } finally {
                map.endRead();
            }
            totalObjs += objs.size();
            for (int i = 0; i < objs.size(); i++) {
                AbstractObject o = objs.get(i);
                Coord otl = o.boundTL();
                Coord obr = o.boundBR();
                String type = o.getClass().getSimpleName();
                String name = null;
                if (o instanceof FreeShelfObject) {
                    name = ((FreeShelfObject) o).shelf().name;
                } else if (o instanceof StairsObject) {
                    name = ((StairsObject) o).getName();
                }
                sb.append("        {\"type\":").append(jstr(type))
                  .append(",\"id\":").append(o.id())
                  .append(",\"x\":").append(otl.x).append(",\"y\":").append(otl.y)
                  .append(",\"w\":").append(obr.x - otl.x).append(",\"h\":").append(obr.y - otl.y);
                if (name != null) {
                    sb.append(",\"name\":").append(jstr(name));
                }
                sb.append("}").append(i < objs.size() - 1 ? "," : "").append("\n");
            }
            sb.append("      ]\n");
            sb.append("    }").append(f < floors.size() - 1 ? "," : "").append("\n");
        }
        sb.append("  ]\n}\n");

        try (Writer w = new OutputStreamWriter(new FileOutputStream(out), StandardCharsets.UTF_8)) {
            w.write(sb.toString());
        }
        System.out.println("exported " + floors.size() + " floor(s), " + totalObjs + " object(s) -> " + out.getAbsolutePath());
    }

    private static String jstr(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append("\"").toString();
    }
}
