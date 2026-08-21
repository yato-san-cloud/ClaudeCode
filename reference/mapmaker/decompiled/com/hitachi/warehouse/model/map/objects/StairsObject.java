/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.util.Collection;

public class StairsObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = 3727495959349610541L;
    private String name = "";
    public static final Color COL_STAIRS = new Color(255, 162, 161);
    static final int minFontSize = 3;
    static final int maxFontSize = 100;
    static final Font fontNoShow = new Font("Arial", 0, 0);
    static final Font[] fontForSize = new Font[98];

    static {
        int size = 3;
        while (size <= 100) {
            StairsObject.fontForSize[size - 3] = new Font("Arial", 0, size);
            ++size;
        }
    }

    public String getName() {
        return this.name;
    }

    public void setName(String name) {
        this.name = name;
    }

    @Override
    public boolean isObstructing() {
        return true;
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        g.setColor(COL_STAIRS);
        g.setStroke(new BasicStroke(1.0f));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
        g.setColor(Color.BLACK);
        g.drawRect(fromX, fromY, toX - fromX, toY - fromY);
        if (this.name != null && g.getFont() != fontNoShow) {
            int rectWidth = toX - fromX;
            int rectHeight = toY - fromY;
            FontMetrics met = g.getFontMetrics();
            int cx = fromX + rectWidth / 2;
            int cy = fromY + rectHeight / 2;
            StringLabel labelName = new StringLabel(this.name);
            labelName.drawIfFits(g, met, cx, cy, rectWidth, rectHeight);
        }
        if (this.getEditLock()) {
            g.setColor(Color.BLACK);
            g.setStroke(new BasicStroke(1.0f));
            g.drawLine(fromX, fromY, toX, toY);
        }
    }

    public int pickLargestFontSize(Graphics2D g, MapView mapView, int currentMaxSize, int screenWidth, int screenHeight) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        if (toX <= 0 || toY <= 0 || fromX >= screenWidth || fromY >= screenHeight) {
            return currentMaxSize;
        }
        int rectWidth = toX - fromX;
        int rectHeight = toY - fromY;
        StringLabel[] labelCands = new StringLabel[]{new StringLabel(this.name)};
        int fontSize = currentMaxSize;
        while (fontSize >= 3) {
            g.setFont(fontForSize[fontSize - 3]);
            FontMetrics met = g.getFontMetrics();
            boolean ok = false;
            StringLabel[] stringLabelArray = labelCands;
            int n = labelCands.length;
            int n2 = 0;
            while (n2 < n) {
                StringLabel label = stringLabelArray[n2];
                if (label.fits(met, rectWidth, rectHeight)) {
                    ok = true;
                    break;
                }
                ++n2;
            }
            if (ok) {
                return fontSize;
            }
            --fontSize;
        }
        return fontSize;
    }

    public static void paintStairsObjects(Collection<StairsObject> stairsObjects, Graphics2D g, MapView mapView, boolean showLabels) {
        int screenWidth = mapView.getWidth();
        int screenHeight = mapView.getHeight();
        if (showLabels) {
            int fontSize = 100;
            for (StairsObject obj : stairsObjects) {
                fontSize = Math.min(fontSize, obj.pickLargestFontSize(g, mapView, fontSize, screenWidth, screenHeight));
            }
            if (fontSize < 3) {
                g.setFont(fontNoShow);
            } else {
                g.setFont(fontForSize[fontSize - 3]);
            }
        } else {
            g.setFont(fontNoShow);
        }
        for (StairsObject obj : stairsObjects) {
            obj.paint(g, mapView);
        }
    }

    public String toString() {
        return "Stairs:" + this.name;
    }

    @Override
    public AbstractObject hardClone() {
        StairsObject newObj = new StairsObject();
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }

    public static class StringLabel {
        public final String[] pieces;

        public StringLabel(String ... pieces) {
            this.pieces = pieces;
        }

        public boolean fits(FontMetrics met, int rectWidth, int rectHeight) {
            int strWidth = 0;
            int strHeight = 0;
            int pieceHeight = met.getHeight();
            String[] stringArray = this.pieces;
            int n = this.pieces.length;
            int n2 = 0;
            while (n2 < n) {
                String piece = stringArray[n2];
                strWidth = Math.max(strWidth, met.stringWidth(piece));
                strHeight += pieceHeight;
                if (strWidth >= rectWidth) {
                    return false;
                }
                if (strHeight >= rectHeight) {
                    return false;
                }
                ++n2;
            }
            return true;
        }

        public boolean drawIfFits(Graphics g, FontMetrics met, int cx, int cy, int rectWidth, int rectHeight) {
            int strWidth = 0;
            int strHeight = 0;
            int pieceHeight = met.getHeight();
            String[] stringArray = this.pieces;
            int n = this.pieces.length;
            int n2 = 0;
            while (n2 < n) {
                String piece = stringArray[n2];
                strWidth = Math.max(strWidth, met.stringWidth(piece));
                strHeight += pieceHeight;
                if (strWidth >= rectWidth) {
                    return false;
                }
                if (strHeight >= rectHeight) {
                    return false;
                }
                ++n2;
            }
            int top = cy - strHeight / 2;
            int i = 0;
            while (i < this.pieces.length) {
                int pieceTop = top + i * pieceHeight;
                int pieceLeft = cx - met.stringWidth(this.pieces[i]) / 2;
                g.drawString(this.pieces[i], pieceLeft, pieceTop + met.getAscent());
                ++i;
            }
            return true;
        }
    }
}

