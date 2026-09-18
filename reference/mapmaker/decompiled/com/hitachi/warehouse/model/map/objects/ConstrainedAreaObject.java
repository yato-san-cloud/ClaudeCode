/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import common.util.StringList;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;

public class ConstrainedAreaObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = -1324363420902488338L;
    public static final int CONSTRAINT_ORIENTATION_VERTICAL = 0;
    public static final int CONSTRAINT_ORIENTATION_HORIZONTAL = 1;
    private int orientation = 0;
    public static final int CONSTRAINT_TRAFFIC_BOTHWAYS = 0;
    public static final int CONSTRAINT_TRAFFIC_RIGHTHAND = 1;
    public static final int CONSTRAINT_TRAFFIC_LEFTHAND = 2;
    private int trafficDirection = 1;
    private double splitPosition = 0.5;
    public static final int ENTRYEXIT_CONSTRAINT_AA = 1;
    public static final int ENTRYEXIT_CONSTRAINT_AA_INVMASK = 14;
    public static final int ENTRYEXIT_CONSTRAINT_AB = 2;
    public static final int ENTRYEXIT_CONSTRAINT_AB_INVMASK = 13;
    public static final int ENTRYEXIT_CONSTRAINT_BA = 4;
    public static final int ENTRYEXIT_CONSTRAINT_BA_INVMASK = 11;
    public static final int ENTRYEXIT_CONSTRAINT_BB = 8;
    public static final int ENTRYEXIT_CONSTRAINT_BB_INVMASK = 7;
    public static final int ENTRYEXIT_NOCONSTRAINT = 15;
    public static final int ENTRY_CONSTRAINT_A = 3;
    public static final int ENTRY_CONSTRAINT_B = 12;
    public static final int EXIT_CONSTRAINT_A = 5;
    public static final int EXIT_CONSTRAINT_B = 10;
    private int entryExitConstraint = 6;
    public static final Color COL_PASSAGE = ColorUtil.setAlpha(Color.ORANGE, 0.4f);

    @Override
    public boolean isObstructing() {
        return false;
    }

    public int orientation() {
        return this.orientation;
    }

    public void setOrientation(int orientation) {
        this.orientation = orientation;
    }

    public int trafficDirection() {
        return this.trafficDirection;
    }

    public void setTrafficDirection(int direction) {
        this.trafficDirection = direction;
    }

    public boolean canMoveBothWays() {
        return this.trafficDirection == 0;
    }

    public boolean isRightHanded() {
        return this.trafficDirection == 1;
    }

    public boolean isLeftHanded() {
        return this.trafficDirection == 2;
    }

    public boolean hasDirectionConstraint() {
        return this.trafficDirection != 0;
    }

    public double width() {
        if (this.orientation == 0) {
            return this.right() - this.left();
        }
        return this.bottom() - this.top();
    }

    public void setSplitPosition(double pos) {
        if (pos < 0.0) {
            pos = 0.0;
        }
        if (pos > 1.0) {
            pos = 1.0;
        }
        this.splitPosition = pos;
    }

    public double splitPosition() {
        return this.splitPosition;
    }

    public int entryExitConstraint() {
        return this.entryExitConstraint;
    }

    public void setEntryExitConstraint(int constraint) {
        this.entryExitConstraint = constraint;
    }

    public boolean canEnterAExitA() {
        return (this.entryExitConstraint & 1) != 0;
    }

    public boolean canEnterAExitB() {
        return (this.entryExitConstraint & 2) != 0;
    }

    public boolean canEnterBExitA() {
        return (this.entryExitConstraint & 4) != 0;
    }

    public boolean canEnterBExitB() {
        return (this.entryExitConstraint & 8) != 0;
    }

    public boolean canEnterA() {
        return (this.entryExitConstraint & 3) != 0;
    }

    public boolean canEnterB() {
        return (this.entryExitConstraint & 0xC) != 0;
    }

    public boolean canExitA() {
        return (this.entryExitConstraint & 5) != 0;
    }

    public boolean canExitB() {
        return (this.entryExitConstraint & 0xA) != 0;
    }

    public void setEnterAExitA(boolean allow) {
        this.entryExitConstraint = this.entryExitConstraint & 0xE | (allow ? 1 : 0);
    }

    public void setEnterAExitB(boolean allow) {
        this.entryExitConstraint = this.entryExitConstraint & 0xD | (allow ? 2 : 0);
    }

    public void setEnterBExitA(boolean allow) {
        this.entryExitConstraint = this.entryExitConstraint & 0xB | (allow ? 4 : 0);
    }

    public void setEnterBExitB(boolean allow) {
        this.entryExitConstraint = this.entryExitConstraint & 7 | (allow ? 8 : 0);
    }

    public boolean canEnterExit(boolean enter, boolean exit) {
        if (enter) {
            if (exit) {
                return this.canEnterAExitA();
            }
            return this.canEnterAExitB();
        }
        if (exit) {
            return this.canEnterBExitA();
        }
        return this.canEnterBExitB();
    }

    public Coord internalCoordForPoint(Coord forPoint, double maxDistanceFromSide_mm) {
        double x;
        double y;
        if (this.orientation == 0) {
            if (forPoint.y < super.top() || super.bottom() <= forPoint.y) {
                return null;
            }
            y = forPoint.y;
            double centerX = MathUtil.map(this.splitPosition, 0.0, 1.0, super.left(), super.right());
            x = this.hasDirectionConstraint() && this.splitPosition != 1.0 && this.splitPosition != 0.0 ? (centerX < forPoint.x ? Math.max(super.right() - maxDistanceFromSide_mm, (centerX + super.right()) / 2.0) : Math.min(super.left() + maxDistanceFromSide_mm, (super.left() + centerX) / 2.0)) : (super.left() + super.right()) / 2.0;
        } else {
            if (forPoint.x < super.left() || super.right() <= forPoint.x) {
                return null;
            }
            x = forPoint.x;
            double centerY = MathUtil.map(this.splitPosition, 0.0, 1.0, super.top(), super.bottom());
            y = this.hasDirectionConstraint() && this.splitPosition != 1.0 && this.splitPosition != 0.0 ? (centerY < forPoint.y ? Math.max(super.bottom() - maxDistanceFromSide_mm, (centerY + super.bottom()) / 2.0) : Math.min(super.top() + maxDistanceFromSide_mm, (super.top() + centerY) / 2.0)) : (this.top() + this.bottom()) / 2.0;
        }
        return new Coord(x, y);
    }

    /*
     * Enabled force condition propagation
     * Lifted jumps to return sites
     */
    public Coord oppositeInternalCoordForPoint(Coord forPoint, double maxDistanceFromSide_mm) {
        Double x = null;
        Double y = null;
        if (this.orientation == 0) {
            if (forPoint.y < super.top() || super.bottom() <= forPoint.y) {
                return null;
            }
            y = forPoint.y;
            double centerX = MathUtil.map(this.splitPosition, 0.0, 1.0, super.left(), super.right());
            if (!this.hasDirectionConstraint() || this.splitPosition == 1.0 || this.splitPosition == 0.0) return null;
            x = centerX > forPoint.x ? Double.valueOf(Math.max(super.right() - maxDistanceFromSide_mm, (centerX + super.right()) / 2.0)) : Double.valueOf(Math.min(super.left() + maxDistanceFromSide_mm, (super.left() + centerX) / 2.0));
            return new Coord(x, y);
        } else {
            if (forPoint.x < super.left() || super.right() <= forPoint.x) {
                return null;
            }
            x = forPoint.x;
            double centerY = MathUtil.map(this.splitPosition, 0.0, 1.0, super.top(), super.bottom());
            if (!this.hasDirectionConstraint() || this.splitPosition == 1.0 || this.splitPosition == 0.0) return null;
            y = centerY > forPoint.y ? Double.valueOf(Math.max(super.bottom() - maxDistanceFromSide_mm, (centerY + super.bottom()) / 2.0)) : Double.valueOf(Math.min(super.top() + maxDistanceFromSide_mm, (super.top() + centerY) / 2.0));
        }
        return new Coord(x, y);
    }

    public Coord[] getStartEndPoints() {
        Coord[] coords;
        if (this.hasDirectionConstraint() && this.splitPosition != 1.0 && this.splitPosition != 0.0) {
            if (this.orientation == 0) {
                double centerX = MathUtil.map(this.splitPosition, 0.0, 1.0, super.left(), super.right());
                coords = new Coord[]{new Coord((this.left() + centerX) / 2.0, this.top()), new Coord((this.right() + centerX) / 2.0, this.top()), new Coord((this.left() + centerX) / 2.0, this.bottom()), new Coord((this.right() + centerX) / 2.0, this.bottom())};
            } else {
                double centerY = MathUtil.map(this.splitPosition, 0.0, 1.0, super.top(), super.bottom());
                coords = new Coord[]{new Coord(this.left(), (this.top() + centerY) / 2.0), new Coord(this.left(), (this.bottom() + centerY) / 2.0), new Coord(this.right(), (this.top() + centerY) / 2.0), new Coord(this.right(), (this.bottom() + centerY) / 2.0)};
            }
        } else if (this.orientation == 0) {
            double centerX = (super.left() + super.right()) / 2.0;
            coords = new Coord[]{new Coord(centerX, this.top()), new Coord(centerX, this.bottom())};
        } else {
            double centerY = (super.top() + super.bottom()) / 2.0;
            coords = new Coord[]{new Coord(this.left(), centerY), new Coord(this.right(), centerY)};
        }
        return coords;
    }

    public boolean checkMoveDirectionConstraint(Waypoint from, Waypoint to) {
        if (this.hasDirectionConstraint()) {
            boolean toIsRightwards;
            if (this.orientation == 0) {
                boolean toIsUpwards;
                if (from.coord().y == to.coord().y) {
                    return true;
                }
                double centerX = MathUtil.map(this.splitPosition, 0.0, 1.0, super.left(), super.right());
                boolean fromIsUpwards = from.coord().x < centerX ? this.isRightHanded() : this.isLeftHanded();
                boolean bl = toIsUpwards = to.coord().x < centerX ? this.isRightHanded() : this.isLeftHanded();
                if (fromIsUpwards != toIsUpwards) {
                    return false;
                }
                return fromIsUpwards == from.coord().y < to.coord().y;
            }
            if (from.coord().x == to.coord().x) {
                return true;
            }
            double centerY = MathUtil.map(this.splitPosition, 0.0, 1.0, super.top(), super.bottom());
            boolean fromIsRightwards = from.coord().y > centerY ? this.isRightHanded() : this.isLeftHanded();
            boolean bl = toIsRightwards = to.coord().y > centerY ? this.isRightHanded() : this.isLeftHanded();
            if (fromIsRightwards != toIsRightwards) {
                return false;
            }
            return fromIsRightwards == from.coord().x < to.coord().x;
        }
        return true;
    }

    public boolean canConnectFromA(Waypoint from, Waypoint to) {
        boolean uTurning;
        if (this.orientation == 0) {
            uTurning = to.coord().y < from.coord().y;
        } else {
            boolean bl = uTurning = to.coord().x < from.coord().x;
        }
        return !uTurning || this.canEnterAExitA();
    }

    public boolean canConnectFromB(Waypoint from, Waypoint to) {
        boolean uTurning;
        if (this.orientation == 0) {
            uTurning = to.coord().y > from.coord().y;
        } else {
            boolean bl = uTurning = to.coord().x > from.coord().x;
        }
        return !uTurning || this.canEnterBExitB();
    }

    public boolean isASideEntry(Waypoint entry) {
        if (!this.canEnterA()) {
            return false;
        }
        if (this.orientation == 0) {
            return entry.coord().y < this.center().y;
        }
        return entry.coord().x < this.center().x;
    }

    public boolean isBSideEntry(Waypoint entry) {
        if (!this.canEnterB()) {
            return false;
        }
        if (this.orientation == 0) {
            return entry.coord().y > this.center().y;
        }
        return entry.coord().x > this.center().x;
    }

    public boolean isASideExit(Waypoint exit) {
        if (!this.canExitA()) {
            return false;
        }
        if (this.orientation == 0) {
            return exit.coord().y < this.center().y;
        }
        return exit.coord().x < this.center().x;
    }

    public boolean isBSideExit(Waypoint exit) {
        if (!this.canExitB()) {
            return false;
        }
        if (this.orientation == 0) {
            return exit.coord().y > this.center().y;
        }
        return exit.coord().x > this.center().x;
    }

    public boolean canExitFromA(Waypoint from, Waypoint to) {
        boolean movingTowardsA;
        if (this.orientation == 0) {
            boolean movingTowardsA2;
            boolean movingTowardsB = to.coord().y > from.coord().y;
            boolean bl = movingTowardsA2 = to.coord().y < from.coord().y;
            return movingTowardsB && this.canEnterAExitB() || movingTowardsA2 && this.canEnterAExitA();
        }
        boolean movingTowardsB = to.coord().x > from.coord().x;
        boolean bl = movingTowardsA = to.coord().x < from.coord().x;
        return movingTowardsB && this.canEnterAExitB() || movingTowardsA && this.canEnterAExitA();
    }

    public boolean canExitFromB(Waypoint from, Waypoint to) {
        boolean movingTowardsA;
        if (this.orientation == 0) {
            boolean movingTowardsA2;
            boolean movingTowardsB = to.coord().y > from.coord().y;
            boolean bl = movingTowardsA2 = to.coord().y < from.coord().y;
            return movingTowardsB && this.canEnterBExitB() || movingTowardsA2 && this.canEnterBExitA();
        }
        boolean movingTowardsB = to.coord().x > from.coord().x;
        boolean bl = movingTowardsA = to.coord().x < from.coord().x;
        return movingTowardsB && this.canEnterBExitB() || movingTowardsA && this.canEnterBExitA();
    }

    public String toString() {
        return String.valueOf(this.canEnterAExitA() ? "AA " : "") + (this.canEnterAExitB() ? "AB " : "") + (this.canEnterBExitA() ? "BA " : "") + (this.canEnterBExitB() ? "BB " : "") + (this.orientation == 0 ? "Vertical" : "Horizontal") + " " + this.splitPosition;
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        g.setColor(COL_PASSAGE);
        g.setStroke(new BasicStroke(1.0f));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
        int centerLineWidth = 4;
        double arrowAngle = 0.5235987755982988;
        if (this.hasDirectionConstraint()) {
            int leftArrowLength;
            int leftToY;
            int leftToX;
            int leftFromY;
            int leftFromX;
            int rightArrowLength;
            int width;
            int rightToY;
            int rightToX;
            int rightFromY;
            int rightFromX;
            int splitToY;
            int splitToX;
            int splitFromY;
            int splitFromX;
            if (this.orientation == 0) {
                splitFromX = (int)MathUtil.map(this.splitPosition, 0.0, 1.0, fromX, toX);
                splitFromY = fromY + centerLineWidth / 2;
                splitToX = splitFromX;
                splitToY = toY - centerLineWidth / 2;
                rightFromX = (int)MathUtil.map((this.splitPosition + 1.0) / 2.0, 0.0, 1.0, fromX, toX);
                rightFromY = (int)MathUtil.map(0.8, 0.0, 1.0, fromY, toY);
                rightToX = rightFromX;
                rightToY = (int)MathUtil.map(0.2, 0.0, 1.0, fromY, toY);
                width = (int)((double)(toX - splitFromX) * 0.8 / 2.0);
                rightArrowLength = (int)Math.min(0.3 * (double)(rightFromY - rightToY), (double)width / Math.sin(arrowAngle));
                leftFromX = (int)MathUtil.map((this.splitPosition + 0.0) / 2.0, 0.0, 1.0, fromX, toX);
                leftFromY = (int)MathUtil.map(0.2, 0.0, 1.0, fromY, toY);
                leftToX = leftFromX;
                leftToY = (int)MathUtil.map(0.8, 0.0, 1.0, fromY, toY);
                width = (int)((double)(splitFromX - fromX) * 0.8 / 2.0);
                leftArrowLength = (int)Math.min(0.3 * (double)(leftToY - leftFromY), (double)width / Math.sin(arrowAngle));
            } else {
                splitFromX = fromX + centerLineWidth / 2;
                splitFromY = (int)MathUtil.map(this.splitPosition, 0.0, 1.0, fromY, toY);
                splitToX = toX - centerLineWidth / 2;
                splitToY = splitFromY;
                rightFromX = (int)MathUtil.map(0.2, 0.0, 1.0, fromX, toX);
                rightFromY = (int)MathUtil.map((this.splitPosition + 1.0) / 2.0, 0.0, 1.0, fromY, toY);
                rightToX = (int)MathUtil.map(0.8, 0.0, 1.0, fromX, toX);
                rightToY = rightFromY;
                width = (int)((double)(toY - splitFromY) * 0.8 / 2.0);
                rightArrowLength = (int)Math.min(0.3 * (double)(rightToX - rightFromX), (double)width / Math.sin(arrowAngle));
                leftFromX = (int)MathUtil.map(0.8, 0.0, 1.0, fromX, toX);
                leftFromY = (int)MathUtil.map((this.splitPosition + 0.0) / 2.0, 0.0, 1.0, fromY, toY);
                leftToX = (int)MathUtil.map(0.2, 0.0, 1.0, fromX, toX);
                leftToY = leftFromY;
                width = (int)((double)(splitFromY - fromY) * 0.8 / 2.0);
                leftArrowLength = (int)Math.min(0.3 * (double)(leftFromX - leftToX), (double)width / Math.sin(arrowAngle));
            }
            g.setColor(Color.ORANGE);
            g.setStroke(new BasicStroke(centerLineWidth));
            g.drawLine(splitFromX, splitFromY, splitToX, splitToY);
            g.setStroke(new BasicStroke(3.0f));
            boolean rightHandTraffic = this.isRightHanded();
            if (this.splitPosition < 1.0) {
                Draw.drawArrow(g, rightFromX, rightFromY, rightToX, rightToY, !rightHandTraffic, rightHandTraffic, rightArrowLength, arrowAngle);
            }
            if (this.splitPosition > 0.0) {
                Draw.drawArrow(g, leftFromX, leftFromY, leftToX, leftToY, !rightHandTraffic, rightHandTraffic, leftArrowLength, arrowAngle);
            }
        } else {
            int splitToY;
            int splitToX;
            int splitFromY;
            int splitFromX;
            int arrowLength = 0;
            if (this.orientation == 0) {
                splitFromX = (fromX + toX) / 2;
                splitFromY = (int)MathUtil.map(0.8, 0.0, 1.0, fromY, toY);
                splitToX = splitFromX;
                splitToY = (int)MathUtil.map(0.2, 0.0, 1.0, fromY, toY);
                int width = (int)((double)(toX - splitFromX) * 0.8 / 2.0);
                arrowLength = (int)Math.min(0.3 * (double)(splitFromY - splitToY), (double)width / Math.sin(arrowAngle));
            } else {
                splitFromX = (int)MathUtil.map(0.2, 0.0, 1.0, fromX, toX);
                splitFromY = (fromY + toY) / 2;
                splitToX = (int)MathUtil.map(0.8, 0.0, 1.0, fromX, toX);
                splitToY = splitFromY;
                int width = (int)((double)(toY - splitFromY) * 0.8 / 2.0);
                arrowLength = (int)Math.min(0.3 * (double)(splitToX - splitFromX), (double)width / Math.sin(arrowAngle));
            }
            g.setColor(Color.ORANGE);
            g.setStroke(new BasicStroke(3.0f));
            Draw.drawArrow(g, splitFromX, splitFromY, splitToX, splitToY, true, true, arrowLength, arrowAngle);
        }
        g.setColor(Color.BLACK);
        g.setFont(new Font("Arial", 0, 15));
        if (this.orientation == 0) {
            Draw.drawStringCenteredAt(g, "A", (fromX + toX) / 2, fromY);
            Draw.drawStringCenteredAt(g, "B", (fromX + toX) / 2, toY);
        } else {
            Draw.drawStringCenteredAt(g, "A", fromX, (fromY + toY) / 2);
            Draw.drawStringCenteredAt(g, "B", toX, (fromY + toY) / 2);
        }
        StringList list = new StringList("\n");
        if (this.canEnterAExitA()) {
            list.add((Object)"AA");
        }
        if (this.canEnterAExitB()) {
            list.add((Object)"AB");
        }
        if (this.canEnterBExitA()) {
            list.add((Object)"BA");
        }
        if (this.canEnterBExitB()) {
            list.add((Object)"BB");
        }
        g.setColor(Color.BLACK);
        Draw.drawString(g, list.toString(), fromX, fromY);
        if (this.getEditLock()) {
            g.setColor(Color.BLACK);
            g.setStroke(new BasicStroke(1.0f));
            g.drawLine(fromX, fromY, toX, toY);
        }
    }

    @Override
    public AbstractObject hardClone() {
        ConstrainedAreaObject newObj = new ConstrainedAreaObject();
        newObj.entryExitConstraint = this.entryExitConstraint;
        newObj.orientation = this.orientation;
        newObj.splitPosition = this.splitPosition;
        newObj.trafficDirection = this.trafficDirection;
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }
}

