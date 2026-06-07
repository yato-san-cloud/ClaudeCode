package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import java.awt.GridLayout;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JTextField;

/**
 * Batch shelf generator (custom add-on).
 *
 * The user specifies the PICK FACE (間口) direction plus a frontage width, depth,
 * count (何連) and gap. Shelves are laid out side-by-side ALONG the pick face
 * (perpendicular to the depth) so every shelf's 間口 stays open to the aisle —
 * they are never stacked in the depth direction (which would block picking).
 *
 * Note: the underlying model stores no facing/rotation, so 上/下 (and 左/右)
 * yield identical geometry; the choice just expresses which aisle the run feeds.
 * What matters is that the run always runs along the 間口 face.
 */
public class ShelfArrayGenerator {

    public static void open(final MapMaker maker) {
        JComboBox<String> cbFace = new JComboBox<String>(new String[]{
                "下を向く（棚は左右に連結）",
                "上を向く（棚は左右に連結）",
                "右を向く（棚は上下に連結）",
                "左を向く（棚は上下に連結）"});
        cbFace.setSelectedIndex(Prefs.getInt("shelfgen.face", 0));
        JTextField tfFront = new JTextField(Prefs.get("shelfgen.frontage", "1000"));
        JTextField tfDepth = new JTextField(Prefs.get("shelfgen.depth", "500"));
        JTextField tfCount = new JTextField(Prefs.get("shelfgen.count", "10"));
        JTextField tfGap = new JTextField(Prefs.get("shelfgen.gap", "0"));
        JTextField tfName = new JTextField(Prefs.get("shelfgen.prefix", ""));

        JPanel panel = new JPanel(new GridLayout(0, 2, 6, 6));
        panel.add(new JLabel("間口（ピック面）の向き")); panel.add(cbFace);
        panel.add(new JLabel("間口の幅 (mm)"));          panel.add(tfFront);
        panel.add(new JLabel("奥行き (mm)"));            panel.add(tfDepth);
        panel.add(new JLabel("連結数 (何連)"));          panel.add(tfCount);
        panel.add(new JLabel("棚どうしの間隔 (mm)"));    panel.add(tfGap);
        panel.add(new JLabel("棚名プレフィックス(空=自動)")); panel.add(tfName);

        int res = JOptionPane.showConfirmDialog(maker.mapFrame, panel, "棚を一括生成（間口指定）",
                JOptionPane.OK_CANCEL_OPTION, JOptionPane.PLAIN_MESSAGE);
        if (res != JOptionPane.OK_OPTION) {
            return;
        }
        try {
            int face = cbFace.getSelectedIndex();
            double frontage = Double.parseDouble(tfFront.getText().trim());
            double depth = Double.parseDouble(tfDepth.getText().trim());
            int count = Integer.parseInt(tfCount.getText().trim());
            double gap = Double.parseDouble(tfGap.getText().trim());
            String prefix = tfName.getText().trim();
            if (frontage <= 0 || depth <= 0 || count <= 0) {
                JOptionPane.showMessageDialog(maker.mapFrame, "サイズと連結数は正の数で入力してください。",
                        "入力エラー", JOptionPane.ERROR_MESSAGE);
                return;
            }
            Prefs.putInt("shelfgen.face", face);
            Prefs.put("shelfgen.frontage", tfFront.getText().trim());
            Prefs.put("shelfgen.depth", tfDepth.getText().trim());
            Prefs.put("shelfgen.count", tfCount.getText().trim());
            Prefs.put("shelfgen.gap", tfGap.getText().trim());
            Prefs.put("shelfgen.prefix", prefix);
            Prefs.save();

            generate(maker, face, frontage, depth, gap, count, prefix);
        } catch (NumberFormatException ex) {
            JOptionPane.showMessageDialog(maker.mapFrame, "数値を正しく入力してください。",
                    "入力エラー", JOptionPane.ERROR_MESSAGE);
        }
    }

    private static void generate(MapMaker maker, int face, double frontage, double depth,
                                 double gap, int count, String prefix) {
        WorldMap map = maker.map();
        if (map == null) {
            return;
        }
        // Pick face 下/上 (index 0/1) => face is a horizontal edge => run along X (left-right).
        // Pick face 右/左 (index 2/3) => face is a vertical edge   => run along Y (up-down).
        // The run is ALWAYS along the frontage, so the depth side (= the 間口) is never blocked.
        boolean horizontalRow = (face == 0 || face == 1);
        double w, h, stepX, stepY;
        if (horizontalRow) {
            w = frontage; h = depth;
            stepX = w + gap; stepY = 0.0;
        } else {
            w = depth; h = frontage;
            stepX = 0.0; stepY = h + gap;
        }

        // center the whole run on the current view
        Coord center = maker.mapFrame.mapView.center();
        double totalW = horizontalRow ? (count * w + (count - 1) * gap) : w;
        double totalH = horizontalRow ? h : (count * h + (count - 1) * gap);
        double startX = center.x - totalW / 2.0;
        double startY = center.y - totalH / 2.0;

        HashSet<String> used = new HashSet<String>();
        for (FreeShelfObject s : map.freeShelfObjects()) {
            used.add(s.shelf().name);
        }
        Iterator<String> candIt = map.shelfNameManager().names().iterator();
        int auto = 1;
        List<FreeShelfObject> created = new ArrayList<FreeShelfObject>();
        try {
            map.startWrite();
            for (int i = 0; i < count; i++) {
                double x = startX + stepX * i;
                double y = startY + stepY * i;
                Coord tl = new Coord(x, y);
                Coord br = new Coord(x + w, y + h);
                String name;
                if (!prefix.isEmpty()) {
                    do {
                        name = prefix + (auto++);
                    } while (used.contains(name));
                } else {
                    name = "";
                    while (candIt.hasNext()) {
                        String cand = candIt.next();
                        if (!used.contains(cand)) {
                            name = cand;
                            break;
                        }
                    }
                }
                used.add(name);
                FreeShelfObject obj = new FreeShelfObject();
                obj.setShelf(new FreeShelfArea(name));
                obj.setBounds(tl, br);
                map.add(obj);
                created.add(obj);
            }
        } finally {
            map.endWrite();
        }
        String dir = horizontalRow ? "左右" : "上下";
        maker.mapFrame.mapView.setMessage(created.size() + " 連の棚を生成（間口を空けて" + dir + "に連結／Ctrl+Zで取消）");
        maker.mapFrame.mapView.repaint();
    }
}
