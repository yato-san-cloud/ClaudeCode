/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.StairsBetweenDistance;
import com.hitachi.warehouse.mapmaker.debug.DebugUtils;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import common.gui.Draw;
import common.util.ColorUtil;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class ScalingPanel
extends AbstractMapPanel {
    List<Integer> allowedSpacings = new ArrayList<Integer>();
    MapMaker maker;

    public ScalingPanel(MapMaker maker) {
        this.maker = maker;
        int maxScaling_m = 20004000;
        this.allowedSpacings = new ArrayList<Integer>();
        int base = 1;
        while (base < maxScaling_m) {
            this.allowedSpacings.add(base);
            this.allowedSpacings.add(base * 2);
            this.allowedSpacings.add(base * 5);
            base *= 10;
        }
        Collections.sort(this.allowedSpacings);
    }

    @Override
    protected void mapViewSet(MapView mapView) {
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
    }

    @Override
    public void draw(Graphics2D g) {
        WorldMap map = this.mapView().map();
        if (map != null) {
            int currentIndex;
            int maxGridSpacing_px = 150;
            double zoom_m_px = this.mapView().zoomLevel() / 1000.0;
            int screenWidth = this.mapView().getWidth();
            int screenHeight = this.mapView().getHeight();
            int scaling = 1;
            for (Integer scale : this.allowedSpacings) {
                if (!((double)scale.intValue() / zoom_m_px < (double)maxGridSpacing_px)) break;
                scaling = scale;
            }
            Coord tl = this.mapView().coordForScreen(0, 0);
            Coord br = this.mapView().coordForScreen(screenWidth, screenHeight);
            double left_m = tl.x / 1000.0;
            double top_m = tl.y / 1000.0;
            double right_m = br.x / 1000.0;
            double bottom_m = br.y / 1000.0;
            int leftIdx = (int)Math.floor(left_m / (double)scaling);
            int rightIdx = (int)Math.ceil(right_m / (double)scaling);
            int topIdx = (int)Math.floor(top_m / (double)scaling);
            int bottomIdx = (int)Math.ceil(bottom_m / (double)scaling);
            g.setColor(Color.GRAY);
            int xIdx = leftIdx;
            while (xIdx <= rightIdx) {
                int x = this.mapView().screenXForWorld(xIdx * scaling * 1000);
                g.drawLine(x, 0, x, this.mapView().getHeight());
                ++xIdx;
            }
            int yIdx = topIdx;
            while (yIdx <= bottomIdx) {
                int y = this.mapView().screenYForWorld(yIdx * scaling * 1000);
                g.drawLine(0, y, this.mapView().getWidth(), y);
                ++yIdx;
            }
            g.setColor(Color.BLACK);
            g.setFont(new Font("Arial", 1, 14));
            String scalingLabel = String.valueOf(scaling) + "m";
            Rectangle rect = Draw.getStringBounds(g, scalingLabel, 0, 0);
            g.drawString(scalingLabel, this.mapView().getWidth() - rect.width, this.mapView().getHeight() - rect.height);
            int y = this.mapView().getHeight() - rect.height + 3;
            int scaleWidth = (int)((double)scaling / zoom_m_px);
            int scaleLeft = this.mapView().getWidth() - scaleWidth - 5;
            int scaleRight = this.mapView().getWidth() - 5;
            g.drawLine(scaleLeft, y - 3, scaleLeft, y + 3);
            g.drawLine(scaleRight, y - 3, scaleRight, y + 3);
            g.drawLine(scaleLeft, y, scaleRight, y);
            int row = 20;
            if (this.maker.ShowFloorName && (currentIndex = this.maker.floorToolBar.getCurrentFloorTabIndex()) != -1) {
                String floorName = this.maker.worldMapMultiFloor.getWorldMapExtension(currentIndex).getName();
                Font floorNameFont = new Font("MS Gothic", 1, 48);
                g.setFont(floorNameFont);
                g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.5));
                Draw.drawString(g, floorName, 5, row);
                row += 60;
            }
            if (this.maker.ShowCalcStatus) {
                Font calcFont = new Font("MS Gothic", 1, 13);
                g.setFont(calcFont);
                g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.5));
                if (this.maker.getCalculatorManager().getExecuteCalc()) {
                    Draw.drawString(g, "経路自動計算：ON", 5, row);
                } else {
                    Draw.drawString(g, "経路自動計算：OFF", 5, row);
                }
                if (this.maker.getCalculatorManager().isCalculating()) {
                    g.setColor(ColorUtil.setAlpha(Color.RED, 0.5));
                    Draw.drawString(g, "計算中 " + (this.maker.getCalculatorManager().generator == null ? "0" : String.valueOf(this.maker.getCalculatorManager().generator.getProgress())) + " %", 20, row + 20);
                } else {
                    String WarningErrorInfo;
                    String errorInfo = this.maker.getCalculatorManager().isErrorInfo();
                    if (this.maker.getCalculatorManager().getExecuteCalc()) {
                        if (errorInfo == null || this.maker.getCalculatorManager().isInterrupt()) {
                            WarningErrorInfo = this.maker.getCalculatorManager().isWarningErrorInfo(false);
                            if (WarningErrorInfo != null) {
                                g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.5));
                                Draw.drawString(g, "計算完了（" + WarningErrorInfo + ")", 20, row + 20);
                            } else {
                                g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.5));
                                Draw.drawString(g, "計算完了", 20, row + 20);
                            }
                        } else {
                            g.setColor(ColorUtil.setAlpha(Color.RED, 1.0));
                            Draw.drawString(g, errorInfo, 20, row + 20);
                        }
                    } else if (errorInfo == null || this.maker.getCalculatorManager().isInterrupt()) {
                        if (this.maker.getCalculatorManager().isNeedsRecalc()) {
                            g.setColor(ColorUtil.setAlpha(Color.RED, 1.0));
                            Draw.drawString(g, "「経路キャッシュ計算」チェックが未実施です。", 20, row + 20);
                        } else {
                            WarningErrorInfo = this.maker.getCalculatorManager().isWarningErrorInfo(false);
                            if (WarningErrorInfo != null) {
                                g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.5));
                                Draw.drawString(g, "計算完了（" + WarningErrorInfo + ")", 20, row + 20);
                            } else {
                                g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.5));
                                Draw.drawString(g, "「経路キャッシュ計算」チェックは、実行済です。", 20, row + 20);
                            }
                        }
                    } else {
                        g.setColor(ColorUtil.setAlpha(Color.RED, 1.0));
                        Draw.drawString(g, errorInfo, 20, row + 20);
                    }
                }
            }
            if (DebugUtils.isDebugMode()) {
                row = 300;
                Font FloorLinkFont = new Font("MS Gothic", 1, 13);
                g.setFont(FloorLinkFont);
                g.setColor(ColorUtil.setAlpha(Color.BLACK, 1.0));
                Draw.drawString(g, "フロアー間接続情報", 5, row);
                FloorLinkFont = new Font("MS Gothic", 0, 12);
                g.setFont(FloorLinkFont);
                int drawy = row + 20;
                for (StairsBetweenDistance stairsBetweenDistance : this.maker.worldMapMultiFloor.StairsBetweenDistanceList) {
                    Draw.drawString(g, stairsBetweenDistance.FromFloor.getName(), 5, drawy);
                    Draw.drawString(g, stairsBetweenDistance.FromStairsObject.getName(), 75, drawy);
                    Draw.drawString(g, stairsBetweenDistance.ToFloor.getName(), 145, drawy);
                    Draw.drawString(g, stairsBetweenDistance.ToStairsObject.getName(), 215, drawy);
                    Draw.drawString(g, String.valueOf(stairsBetweenDistance.Distance), 285, drawy);
                    drawy += 20;
                }
            }
        }
    }
}

